import { lib } from "../native/loader.ts";
import { check, checkRc, cstr, json } from "../native/ffi.ts";
import type { MessageType } from "../interfaces/registry.ts";
import { Entity, type EntityOptions } from "./entity.ts";
import { QoS } from "./qos.ts";
import type { Pointer } from "bun:ffi";
import type { MessageArg } from "../types.ts";
import { assertValidMessage, type MessageValidationOptions } from "./message_validation.ts";
import { createEvents, type EventCallbacks, type QoSEvent } from "./event_handler.ts";
import { OperationError } from "./errors.ts";
import { openView } from "./message_view.ts";
import { cycloneDds11, hasFixedArray, LoanedMessage, viewInfo } from "./loaned_message.ts";

export { LoanedMessage };

export class Publisher<T = any> extends Entity {
  readonly typeClass: MessageType;
  readonly loggerName: string;
  readonly #qos: QoS;
  #validate: boolean;
  #validationOptions: MessageValidationOptions;
  /** @internal */
  readonly _events: QoSEvent[];
  readonly #loans = new Set<LoanedMessage<T>>();

  /** @internal */
  constructor(nodeHandle: Pointer, loggerName: string, msgType: MessageType, topic: string, options: EntityOptions, eventCallbacks?: EventCallbacks) {
    const qos = QoS.from(options.qos);
    const h = check(lib.rb_pub_init(nodeHandle, msgType.typeSupport(), cstr(topic), qos.toNative()), `create publisher '${topic}'`);
    super(h, options);
    this.typeClass = msgType;
    this.loggerName = loggerName;
    this.#qos = qos;
    this.#validate = options.validateMessages === true;
    this.#validationOptions = options.validationOptions ?? { strict: true, checkTypes: true };
    this._events = createEvents(h, false, eventCallbacks);
  }

  get qos(): QoS {
    return this.#qos;
  }

  get topic(): string {
    return String(lib.rb_pub_topic(this.handle));
  }

  /**
   * Publishes a message object (or a bare value for single-`data` messages),
   * or raw CDR bytes (Uint8Array/Buffer). `validate` overrides validateMessages.
   */
  publish(msg: MessageArg<T> | Uint8Array | LoanedMessage<T>, options: { validate?: boolean } = {}): void {
    this.assertAlive();
    if (msg instanceof LoanedMessage) return this.publishLoanedMessage(msg);
    let bytes: Uint8Array;
    if (msg instanceof Uint8Array) {
      bytes = msg;
    } else {
      if (options.validate ?? this.#validate) assertValidMessage(msg, this.typeClass, this.#validationOptions);
      bytes = this.typeClass.encode(msg);
    }
    checkRc(lib.rb_pub_publish(this.handle, bytes, bytes.length), `publish on ${this.topic}`);
  }

  /**
   * True if the middleware lends message memory for this publisher (Fast DDS with
   * fixed-size types, Cyclone DDS with shared memory). Not for types with fixed-size
   * arrays on Cyclone DDS 11 (see cycloneDds11()). borrowLoanedMessage() works either way.
   */
  get canLoanMessages(): boolean {
    return lib.rb_pub_can_loan(this.handle) === 1 && !(cycloneDds11() && hasFixedArray(this.typeClass));
  }

  /**
   * Borrows a message to fill in place and publish without serializing it in
   * JavaScript. The type must be fixed-size (no strings or sequences). When the
   * middleware cannot loan, the message lives in a C message owned by rclbunjs and
   * is published with rcl_publish.
   */
  borrowLoanedMessage(): LoanedMessage<T> {
    this.assertAlive();
    const info = viewInfo(this.typeClass);
    const ts = this.typeClass.typeSupport();
    const loaned = this.canLoanMessages;
    const p = loaned ? check(lib.rb_pub_borrow(this.handle, ts), `borrow a message on ${this.topic}`) : check(lib.rb_msg_alloc(ts), "allocate a message");
    const loan = new LoanedMessage<T>(this, p, loaned, openView<T>(info, p));
    this.#loans.add(loan);
    return loan;
  }

  /** Publishes a borrowed message; the loan is used up even if publishing fails. */
  publishLoanedMessage(loan: LoanedMessage<T>): void {
    this.assertAlive();
    const p = this.#claim(loan);
    if (loan.isLoaned) {
      checkRc(lib.rb_pub_publish_loaned(this.handle, p), `publish a loaned message on ${this.topic}`);
      return;
    }
    try {
      checkRc(lib.rb_pub_publish_c(this.handle, p), `publish on ${this.topic}`);
    } finally {
      lib.rb_msg_free(this.typeClass.typeSupport(), p);
    }
  }

  /** Gives a borrowed message back without publishing it. */
  returnLoanedMessage(loan: LoanedMessage<T>): void {
    this.#giveBack(this.#claim(loan), loan.isLoaned);
  }

  #claim(loan: LoanedMessage<T>): Pointer {
    if (loan._publisher !== this) throw new OperationError("the loaned message belongs to another publisher");
    this.#loans.delete(loan);
    return loan._take();
  }

  #giveBack(p: Pointer, loaned: boolean): void {
    if (loaned) checkRc(lib.rb_pub_return_loaned(this.handle, p), "return a loaned message");
    else lib.rb_msg_free(this.typeClass.typeSupport(), p);
  }

  get willValidateMessage(): boolean {
    return this.#validate;
  }

  set willValidateMessage(value: boolean) {
    this.#validate = value;
  }

  /** Merges options into the validation options used by publish(). */
  setValidation(options: MessageValidationOptions): void {
    if (options && Object.keys(options).length > 0) this.#validationOptions = { ...this.#validationOptions, ...options };
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
    // loans must go back before the publisher is finalized
    for (const loan of this.#loans) {
      try {
        this.#giveBack(loan._take(), loan.isLoaned);
      } catch {
        // teardown continues; the middleware reclaims loans with the writer
      }
    }
    this.#loans.clear();
    this.markDestroyed();
    for (const e of this._events) e.fini();
    lib.rb_pub_fini(this.handle);
  }
}
