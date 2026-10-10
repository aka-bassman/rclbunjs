// Loaned messages: message memory lent by the middleware (rcl_borrow_loaned_message /
// rcl_take_loaned_message), presented as views (message_view.ts).
import type { Pointer } from "bun:ffi";
import { readFileSync } from "node:fs";
import type { MessageType } from "../interfaces/registry.ts";
import { json } from "../native/ffi.ts";
import { lib } from "../native/loader.ts";
import { OperationError } from "./errors.ts";
import { compileView, firstVariableField, type Layout, type MessageView, type ViewInfo } from "./message_view.ts";

const views = new WeakMap<MessageType, ViewInfo>();

/**
 * Compiled view class for a message type. Throws a TypeError for types that are
 * not fixed-size (strings or sequences anywhere in the message).
 */
export function viewInfo(type: MessageType): ViewInfo {
  let v = views.get(type);
  if (!v) {
    const layout = json<Layout>(lib.rb_msg_layout(type.typeSupport()), `layout of ${type.name}`);
    const variable = firstVariableField(layout);
    if (variable) {
      throw new TypeError(`${type.name} is not a fixed-size message (field '${variable}' is a string or a sequence); loaned messages need fixed-size types`);
    }
    v = { size: layout.size, View: compileView(layout, type.name) };
    views.set(type, v);
  }
  return v;
}

/** True when the type has no strings or sequences, i.e. it can be used with loaned messages. */
export function isFixedSizeMessage(type: MessageType): boolean {
  try {
    viewInfo(type);
    return true;
  } catch (e) {
    if (e instanceof TypeError) return false;
    throw e;
  }
}

let cyclone11: boolean | undefined;

/**
 * True with rmw_cyclonedds_cpp on Cyclone DDS 11 (Lyrical and later), whose loans
 * (with shared memory) cannot be used as reported (rmw_cyclonedds 4.1/4.2):
 * - rmw_take_loaned_message aborts the process unless the sample is a raw shared-memory
 *   chunk: for serialized data (rclbunjs' publish(object), rosbag2), data from another
 *   host, or the unregister notice when a publisher goes away, Cyclone allocates the
 *   sample through the sertype's realloc_samples, which throws "not implemented";
 * - for types with fixed-size arrays, ArrayValueType leaves m_is_self_contained
 *   uninitialized, so a publisher can report loans for a type Cyclone does not treat as
 *   memcpy-safe, and publishing the loan fails an assertion in dds_write.
 * Subscriptions there take into a C message, and publishers of such types use one.
 */
export function cycloneDds11(): boolean {
  if (cyclone11 === undefined) {
    cyclone11 = false;
    if (String(lib.rb_rmw_implementation()) === "rmw_cyclonedds_cpp") {
      try {
        const m = /libddsc\.so\.(\d+)/.exec(readFileSync("/proc/self/maps", "utf8"));
        cyclone11 = !!m && Number(m[1]) >= 11;
      } catch {
        // no /proc (not Linux)
      }
    }
  }
  return cyclone11;
}

/** True if the type, or a type nested in it, has a fixed-size array. */
export function hasFixedArray(type: MessageType): boolean {
  return type.definitions.some((d) => d.definitions.some((f) => !f.isConstant && f.isArray && f.arrayLength !== undefined));
}

/**
 * A message borrowed from a publisher: its fields are written in place, in
 * middleware memory when the middleware can loan (Fast DDS with fixed-size
 * types), otherwise in a C message owned by rclbunjs. Publish it with
 * `publisher.publish(loan)` or give it back with `publisher.returnLoanedMessage(loan)`;
 * after either, `message` and arrays taken from it no longer work (with the
 * publisher option `reuseViews` they keep working on memory that is no longer yours).
 */
export class LoanedMessage<T = any> {
  /** The message, edited in place. */
  readonly message: MessageView<T>;
  /** True when the memory belongs to the middleware (a real loan). */
  readonly isLoaned: boolean;
  /** @internal */
  readonly _publisher: object;
  #ptr: Pointer | null;
  #release: () => void;

  /** @internal */
  constructor(publisher: object, p: Pointer, isLoaned: boolean, view: { view: MessageView<T>; release(): void }) {
    this._publisher = publisher;
    this.#ptr = p;
    this.isLoaned = isLoaned;
    this.message = view.view;
    this.#release = view.release;
  }

  /** False once the message was published or returned. */
  get isValid(): boolean {
    return this.#ptr !== null;
  }

  /** @internal detaches the view and hands the pointer back to the publisher */
  _take(): Pointer {
    const p = this.#ptr;
    if (p === null) throw new OperationError("loaned message was already published or returned");
    this.#ptr = null;
    this.#release();
    return p;
  }
}

