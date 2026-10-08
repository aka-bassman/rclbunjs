import { ptr, toArrayBuffer, type Pointer } from "bun:ffi";
import { lib } from "../native/loader.ts";
import { check, checkRc, cstr, cstrArray, json } from "../native/ffi.ts";
import { createEvents, type EventCallbacks, type QoSEvent } from "./event_handler.ts";
import type { MessageType } from "../interfaces/registry.ts";
import { convertForDelivery, Entity, type EntityOptions } from "./entity.ts";
import type { Waitable } from "./executor.ts";
import { QoS } from "./qos.ts";

export class MessageInfo {
  constructor(
    readonly sourceTimestamp: bigint,
    readonly receivedTimestamp: bigint,
    readonly publicationSequenceNumber: bigint,
    readonly receptionSequenceNumber: bigint,
    readonly fromIntraProcess: boolean,
  ) {}

  toPlainObject() {
    return { ...this };
  }
}

export interface ContentFilter {
  expression: string;
  parameters?: unknown[];
}

export type SubscriptionCallback<T> = (msg: T, info?: MessageInfo) => void;

const OUT = new BigUint64Array(1);
const INFO = new BigInt64Array(5);
// Messages drained per wake-up before yielding back to the event loop.
const MAX_TAKE = 256;

export class Subscription<T = any> extends Entity implements Waitable {
  readonly typeClass: MessageType;
  readonly loggerName: string;
  readonly isRaw: boolean;
  readonly #callback: SubscriptionCallback<any>;
  readonly #wantsInfo: boolean;
  readonly #qos: QoS;
  /** @internal */
  readonly _events: QoSEvent[];
  /** @internal set by the node: parks its wait thread before we mutate reader state */
  _quiesce: () => void = () => {};

  /** @internal */
  constructor(
    nodeHandle: Pointer,
    loggerName: string,
    msgType: MessageType,
    topic: string,
    options: EntityOptions,
    callback: SubscriptionCallback<T>,
    eventCallbacks?: EventCallbacks,
  ) {
    const qos = QoS.from(options.qos);
    const cf = options.contentFilter as ContentFilter | undefined;
    const fa = cstrArray((cf?.parameters ?? []).map(String));
    const h = check(
      lib.rb_sub_init(nodeHandle, msgType.typeSupport(), cstr(topic), qos.toNative(), cf?.expression ? cstr(cf.expression) : null, fa.argc, fa.argv),
      `create subscription '${topic}'`,
    );
    void fa.keep;
    super(h, options);
    this.typeClass = msgType;
    this.loggerName = loggerName;
    this.isRaw = options.isRaw === true;
    this.#callback = callback;
    this.#wantsInfo = callback.length >= 2;
    this.#qos = qos;
    this._events = createEvents(h, true, eventCallbacks);
  }

  get qos(): QoS {
    return this.#qos;
  }

  get topic(): string {
    return String(lib.rb_sub_topic(this.handle));
  }

  get publisherCount(): number {
    return Number(checkRc(lib.rb_sub_publisher_count(this.handle), "publisher count"));
  }

  get actualQoS(): QoS {
    return QoS.fromJSON(json(lib.rb_sub_qos(this.handle), "subscription qos"));
  }

  /** True if the middleware applies a content filter on this subscription. */
  hasContentFilter(): boolean {
    return lib.rb_sub_is_cft_enabled(this.handle) === 1;
  }

  /** Content filtering is available on the rmw (Fast DDS, Connext). */
  isContentFilterSupported(): boolean {
    return /fastrtps|connext/.test(String(lib.rb_rmw_implementation()));
  }

  setContentFilter(filter: ContentFilter): boolean {
    // Changing the filter while the wait thread sits in rcl_wait races inside
    // the DDS reader (segfaults with Fast DDS), so park the thread first.
    this._quiesce();
    const a = cstrArray((filter.parameters ?? []).map(String));
    const rc = lib.rb_sub_set_content_filter(this.handle, cstr(filter.expression), a.argc, a.argv);
    void a.keep;
    return rc === 0;
  }

  getContentFilter(): ContentFilter | undefined {
    if (!this.hasContentFilter()) return undefined;
    const s = lib.rb_sub_get_content_filter(this.handle);
    return s === null ? undefined : json<ContentFilter>(s, "content filter");
  }

  clearContentFilter(): boolean {
    return this.setContentFilter({ expression: "" });
  }

  /** @internal take everything that is available and run the callback */
  execute(): void {
    for (let i = 0; i < MAX_TAKE && !this.isDestroyed(); i++) {
      const n = Number(checkRc(lib.rb_sub_take(this.handle, ptr(OUT)), `take on ${this.topic}`));
      if (n === 0) return;
      const view = new Uint8Array(toArrayBuffer(Number(OUT[0]) as Pointer, 0, n));
      const msg = this.isRaw ? view.slice() : convertForDelivery(this.typeClass.decode(view), this.options);
      if (this.#wantsInfo) {
        lib.rb_sub_last_info(this.handle, ptr(INFO));
        this.#callback(msg, new MessageInfo(INFO[0]!, INFO[1]!, INFO[2]!, INFO[3]!, INFO[4] === 1n));
      } else {
        this.#callback(msg);
      }
    }
  }

  /** @internal */
  _fini(): void {
    if (this.isDestroyed()) return;
    this.markDestroyed();
    for (const e of this._events) e.fini();
    lib.rb_sub_fini(this.handle);
  }
}
