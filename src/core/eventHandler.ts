// QoS event callbacks for publishers and subscriptions (rclnodejs lib/event_handler.js).
import type { Pointer } from "bun:ffi";
import { lib } from "../native/loader.ts";
import { check, json } from "../native/ffi.ts";
import type { Waitable } from "./executor.ts";

export interface CountStatus {
  total_count: number;
  total_count_change: number;
}
export interface IncompatibleQoSStatus extends CountStatus {
  last_policy_kind: number;
}
export interface MatchedStatus extends CountStatus {
  current_count: number;
  current_count_change: number;
}
export interface LivelinessChangedStatus {
  alive_count: number;
  not_alive_count: number;
  alive_count_change: number;
  not_alive_count_change: number;
}

const KIND = { deadline: 0, liveliness: 1, incompatibleQos: 2, incompatibleType: 3, matched: 4, messageLost: 5 } as const;
type Kind = keyof typeof KIND;

/** Callbacks for publisher QoS events. Properties may also be passed as a plain object. */
export class PublisherEventCallbacks {
  deadline?: (s: CountStatus) => void;
  liveliness?: (s: CountStatus) => void;
  incompatibleQos?: (s: IncompatibleQoSStatus) => void;
  incompatibleType?: (s: CountStatus) => void;
  matched?: (s: MatchedStatus) => void;
}

export class SubscriptionEventCallbacks {
  deadline?: (s: CountStatus) => void;
  liveliness?: (s: LivelinessChangedStatus) => void;
  incompatibleQos?: (s: IncompatibleQoSStatus) => void;
  incompatibleType?: (s: CountStatus) => void;
  matched?: (s: MatchedStatus) => void;
  messageLost?: (s: CountStatus) => void;
}

export type EventCallbacks = Partial<Record<Kind, (status: any) => void>>;

/** @internal one rcl_event_t bound to a callback */
export class QoSEvent implements Waitable {
  readonly handle: Pointer;
  #cb: (status: any) => void;
  #destroyed = false;

  constructor(entityHandle: Pointer, isSubscription: boolean, kind: Kind, cb: (status: any) => void) {
    this.handle = check(lib.rb_event_init(entityHandle, isSubscription ? 1 : 0, KIND[kind]), `QoS event '${kind}'`);
    this.#cb = cb;
  }

  isDestroyed(): boolean {
    return this.#destroyed;
  }

  execute(): void {
    const s = lib.rb_event_take(this.handle);
    if (s === null) return;
    this.#cb(json(s, "event status"));
  }

  fini(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    lib.rb_event_fini(this.handle);
  }
}

/** Creates the events requested in `callbacks` for an entity. */
export function createEvents(entityHandle: Pointer, isSubscription: boolean, callbacks: EventCallbacks | undefined): QoSEvent[] {
  if (!callbacks) return [];
  const out: QoSEvent[] = [];
  for (const k of Object.keys(KIND) as Kind[]) {
    const cb = callbacks[k];
    if (typeof cb !== "function") continue;
    if (k === "messageLost" && !isSubscription) continue;
    out.push(new QoSEvent(entityHandle, isSubscription, k, cb));
  }
  return out;
}
