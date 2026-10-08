// Subscription exposed as an Observable (rclnodejs lib/observable_subscription.js).
// Uses an RxJS Subject when `rxjs` is installed; otherwise a minimal subject
// that still implements the Observable interop protocol (so rxjs `from()` and
// other libraries can consume it) and async iteration.
import type { Subscription } from "./subscription.ts";

export interface Observer<T> {
  next?: (value: T) => void;
  error?: (err: unknown) => void;
  complete?: () => void;
}

export interface Unsubscribable {
  unsubscribe(): void;
}

export interface ObservableLike<T> {
  subscribe(observer?: Partial<Observer<T>> | ((value: T) => void)): Unsubscribable;
}

interface SubjectLike<T> extends Observer<T> {
  asObservable(): ObservableLike<T>;
}

const observableSymbol: symbol = (Symbol as { observable?: symbol }).observable ?? Symbol.for("@@observable");

/** @internal exported for tests */
export class MiniSubject<T> implements SubjectLike<T> {
  #observers = new Set<Observer<T>>();
  #done = false;

  next(value: T): void {
    for (const o of [...this.#observers]) o.next?.(value);
  }

  error(err: unknown): void {
    this.#done = true;
    for (const o of this.#observers) o.error?.(err);
    this.#observers.clear();
  }

  complete(): void {
    this.#done = true;
    for (const o of this.#observers) o.complete?.();
    this.#observers.clear();
  }

  asObservable(): ObservableLike<T> {
    const subscribe = (observer?: Partial<Observer<T>> | ((value: T) => void)): Unsubscribable => {
      // keep the observer object itself: its methods may live on a prototype (rxjs Subscriber)
      const o: Observer<T> = typeof observer === "function" ? { next: observer } : (observer ?? {});
      if (this.#done) {
        o.complete?.();
        return { unsubscribe() {} };
      }
      this.#observers.add(o);
      return { unsubscribe: () => void this.#observers.delete(o) };
    };
    const obs = {
      subscribe,
      [observableSymbol]() {
        return obs;
      },
      ["@@observable"]() {
        return obs;
      },
    };
    return obs;
  }
}

function makeSubject<T>(): SubjectLike<T> {
  try {
    // optional peer dependency
    const rx = require("rxjs") as { Subject: new () => SubjectLike<T> };
    return new rx.Subject();
  } catch {
    return new MiniSubject<T>();
  }
}

export class ObservableSubscription<T = any> implements AsyncIterable<T> {
  #subscription: Subscription<T>;
  #subject = makeSubject<T>();
  #observable: ObservableLike<T>;
  #destroyed = false;

  /** @internal */
  constructor(subscription: Subscription<T>) {
    this.#subscription = subscription;
    this.#observable = this.#subject.asObservable();
  }

  /** An RxJS Observable when rxjs is installed, otherwise an interop-compatible observable. */
  get observable(): ObservableLike<T> {
    return this.#observable;
  }

  get subscription(): Subscription<T> {
    return this.#subscription;
  }

  get topic(): string {
    return this.#subscription.topic;
  }

  get isDestroyed(): boolean {
    return this.#destroyed;
  }

  /** @internal */
  _emit(message: T): void {
    if (!this.#destroyed) this.#subject.next?.(message);
  }

  /** Completes the observable; the underlying subscription stays alive. */
  complete(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#subject.complete?.();
  }

  destroy(): void {
    this.complete();
  }

  /** `for await (const msg of observableSubscription)` until complete(). */
  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    const queue: T[] = [];
    let wake: (() => void) | undefined;
    let done = false;
    const sub = this.#observable.subscribe({
      next: (m) => {
        queue.push(m);
        wake?.();
      },
      complete: () => {
        done = true;
        wake?.();
      },
    });
    try {
      for (;;) {
        while (queue.length) yield queue.shift()!;
        if (done) return;
        await new Promise<void>((r) => (wake = r));
        wake = undefined;
      }
    } finally {
      sub.unsubscribe();
    }
  }
}
