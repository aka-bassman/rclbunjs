import { ptr, toArrayBuffer, type Pointer } from "bun:ffi";
import { lib } from "../native/loader.ts";
import { check, checkRc, cstr, cstrArray, json } from "../native/ffi.ts";
import { createEvents, type EventCallbacks, type QoSEvent } from "./event_handler.ts";
import type { MessageType } from "../interfaces/registry.ts";
import { convertForDelivery, Entity, type EntityOptions } from "./entity.ts";
import type { Waitable } from "./executor.ts";
import { QoS } from "./qos.ts";
import { openView, ReusedViews, type ViewInfo } from "./message_view.ts";
import { cycloneDds11, viewInfo } from "./loaned_message.ts";

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

const ZERO_COPY = { zeroCopy: true };
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
  /** set for loanedMessages subscriptions */
  readonly #view: ViewInfo | null;
  /** loanedMessages without middleware loans: C message reused for every take */
  #cmsg: Pointer | null = null;
  /** loanedMessages with reuseViews */
  readonly #views: ReusedViews | null;
  /** loanedMessages: messages lent to running callbacks, given back by _fini if one destroys us */
  readonly #lentAt: Pointer[] = [];
  readonly #lent: { release(): void }[] = [];
  /** ArrayBuffer over the shim's serialized take buffer, kept while its address and size allow */
  #takeBuf: ArrayBuffer | null = null;
  #takeAt = 0;
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
    // compiled first: throws for types that are not fixed-size
    const view = options.loanedMessages ? viewInfo(msgType) : null;
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
    this.#view = view;
    this.#views = view && options.reuseViews === true ? new ReusedViews(view) : null;
    if (view && !this.canLoanMessages) this.#cmsg = check(lib.rb_msg_alloc(msgType.typeSupport()), "allocate a message");
    this._events = createEvents(h, true, eventCallbacks);
  }

  /**
   * True if the middleware lends received messages (used when loanedMessages is set).
   * Never with rmw_cyclonedds on Cyclone DDS 11 (see cycloneDds11()).
   */
  get canLoanMessages(): boolean {
    return lib.rb_sub_can_loan(this.handle) === 1 && !cycloneDds11();
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
    if (this.#view) return this.#executeViews(this.#view);
    for (let i = 0; i < MAX_TAKE && !this.isDestroyed(); i++) {
      const n = Number(checkRc(lib.rb_sub_take(this.handle, ptr(OUT)), `take on ${this.topic}`));
      if (n === 0) return;
      // a new ArrayBuffer per take would count n bytes against the GC each time; the
      // bytes are copied out below, so one buffer over the take memory can be reused
      const at = Number(OUT[0]);
      if (at !== this.#takeAt || this.#takeBuf!.byteLength < n) {
        this.#takeBuf = toArrayBuffer(at as Pointer, 0, n);
        this.#takeAt = at;
      }
      const view = new Uint8Array(this.#takeBuf!, 0, n);
      const msg = this.isRaw
        ? view.slice()
        : convertForDelivery(this.options.zeroCopy ? this.typeClass.decode(view.slice(), ZERO_COPY) : this.typeClass.decode(view), this.options);
      if (this.#wantsInfo) {
        lib.rb_sub_last_info(this.handle, ptr(INFO));
        this.#callback(msg, new MessageInfo(INFO[0]!, INFO[1]!, INFO[2]!, INFO[3]!, INFO[4] === 1n));
      } else {
        this.#callback(msg);
      }
    }
  }

  #executeViews(info: ViewInfo): void {
    const cmsg = this.#cmsg;
    for (let i = 0; i < MAX_TAKE && !this.isDestroyed(); i++) {
      let p: Pointer;
      if (cmsg) {
        if (checkRc(lib.rb_sub_take_c(this.handle, cmsg), `take on ${this.topic}`) === 0) return;
        p = cmsg;
      } else {
        if (checkRc(lib.rb_sub_take_loaned(this.handle, ptr(OUT)), `take a loaned message on ${this.topic}`) === 0) return;
        p = Number(OUT[0]) as Pointer;
      }
      const v = this.#views ? this.#views.open(p) : openView(info, p);
      this.#lentAt.push(p);
      this.#lent.push(v);
      try {
        if (this.#wantsInfo) {
          lib.rb_sub_last_info(this.handle, ptr(INFO));
          this.#callback(v.view, new MessageInfo(INFO[0]!, INFO[1]!, INFO[2]!, INFO[3]!, INFO[4] === 1n));
        } else {
          this.#callback(v.view);
        }
      } finally {
        // a callback that destroyed the subscription had _fini give the message back
        if (!this.isDestroyed()) {
          this.#lentAt.pop();
          this.#lent.pop();
          v.release();
          if (!cmsg) lib.rb_sub_return_loaned(this.handle, p);
        }
      }
    }
  }

  /** @internal */
  _fini(): void {
    if (this.isDestroyed()) return;
    this.markDestroyed();
    // destroyed from its own callback: that message goes back before the reader does
    for (let i = this.#lent.length - 1; i >= 0; i--) {
      this.#lent[i]!.release();
      if (!this.#cmsg) lib.rb_sub_return_loaned(this.handle, this.#lentAt[i]!);
    }
    this.#lent.length = 0;
    this.#lentAt.length = 0;
    this.#views?.detachAll();
    for (const e of this._events) e.fini();
    lib.rb_sub_fini(this.handle);
    if (this.#cmsg) lib.rb_msg_free(this.typeClass.typeSupport(), this.#cmsg);
    this.#cmsg = null;
    this.#takeBuf = null;
  }
}
