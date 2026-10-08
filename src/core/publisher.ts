import { lib } from "../native/loader.ts";
import { check, checkRc, cstr, json } from "../native/ffi.ts";
import type { MessageType } from "../interfaces/registry.ts";
import { Entity, type EntityOptions } from "./entity.ts";
import { QoS } from "./qos.ts";
import type { Pointer } from "bun:ffi";
import type { MessageInput } from "../types.ts";
import { createEvents, type EventCallbacks, type QoSEvent } from "./event_handler.ts";

export class Publisher<T = any> extends Entity {
  readonly typeClass: MessageType;
  readonly loggerName: string;
  readonly #qos: QoS;
  /** @internal */
  readonly _events: QoSEvent[];

  /** @internal */
  constructor(nodeHandle: Pointer, loggerName: string, msgType: MessageType, topic: string, options: EntityOptions, eventCallbacks?: EventCallbacks) {
    const qos = QoS.from(options.qos);
    const h = check(lib.rb_pub_init(nodeHandle, msgType.typeSupport(), cstr(topic), qos.toNative()), `create publisher '${topic}'`);
    super(h, options);
    this.typeClass = msgType;
    this.loggerName = loggerName;
    this.#qos = qos;
    this._events = createEvents(h, false, eventCallbacks);
  }

  get qos(): QoS {
    return this.#qos;
  }

  get topic(): string {
    return String(lib.rb_pub_topic(this.handle));
  }

  /** Publishes a message object, or raw CDR bytes (Uint8Array/Buffer). */
  publish(msg: MessageInput<T> | Uint8Array): void {
    this.assertAlive();
    const bytes = msg instanceof Uint8Array ? msg : this.typeClass.encode(msg);
    checkRc(lib.rb_pub_publish(this.handle, bytes, bytes.length), `publish on ${this.topic}`);
  }

  get subscriptionCount(): number {
    return Number(checkRc(lib.rb_pub_subscription_count(this.handle), "subscription count"));
  }

  /** Waits until all published messages are acknowledged (reliable QoS). Timeout in ns. */
  waitForAllAcked(timeout: bigint): boolean {
    return checkRc(lib.rb_pub_wait_for_all_acked(this.handle, timeout), "wait for all acked") === 1;
  }

  assertLiveliness(): void {
    checkRc(lib.rb_pub_assert_liveliness(this.handle), "assert liveliness");
  }

  /** QoS actually used by the middleware. */
  get actualQoS(): QoS {
    return QoS.fromJSON(json(lib.rb_pub_qos(this.handle), "publisher qos"));
  }

  /** @internal */
  _fini(): void {
    if (this.isDestroyed()) return;
    this.markDestroyed();
    for (const e of this._events) e.fini();
    lib.rb_pub_fini(this.handle);
  }
}
