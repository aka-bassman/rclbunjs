import { ptr, toArrayBuffer, type Pointer } from "bun:ffi";
import { lib } from "../native/loader.ts";
import { check, checkRc, cstr } from "../native/ffi.ts";
import type { ServiceType } from "../interfaces/registry.ts";
import { convertForDelivery, Entity, type EntityOptions } from "./entity.ts";
import { AbortError, TimeoutError } from "./errors.ts";
import type { Waitable } from "./executor.ts";
import { QoS } from "./qos.ts";
import type { MessageArg } from "../types.ts";
import { assertValidMessage, type MessageValidationOptions } from "./messageValidation.ts";
import type { Clock } from "./clock.ts";
import { configureIntrospection, type ServiceIntrospectionStates } from "./service.ts";

const SEQ = new BigInt64Array(1);
const OUT = new BigUint64Array(1);
// Responses taken per wake-up before yielding back to the event loop.
const MAX_TAKE = 256;

interface Pending {
  resolve: (v: any) => void;
  reject: (e: unknown) => void;
  cleanup?: () => void;
}

export class Client<Req = any, Resp = any> extends Entity implements Waitable {
  readonly typeClass: ServiceType;
  readonly loggerName: string;
  readonly #pending = new Map<bigint, Pending>();
  readonly #qos: QoS;
  /** @internal resolved service name */
  readonly _name: string;
  #validate: boolean;
  #validationOptions: MessageValidationOptions;

  /** @internal */
  constructor(nodeHandle: Pointer, loggerName: string, srvType: ServiceType, serviceName: string, options: EntityOptions) {
    const qos = QoS.from(options.qos, QoS.profileServicesDefault);
    const h = check(
      lib.rb_client_init(
        nodeHandle,
        srvType.typeSupport(),
        cstr(serviceName),
        qos.toNative(),
        srvType.request.typeSupport(),
        srvType.response.typeSupport(),
      ),
      `create client '${serviceName}'`,
    );
    super(h, options);
    this.typeClass = srvType;
    this.loggerName = loggerName;
    this.#qos = qos;
    this._name = String(lib.rb_client_service_name(h));
    this.#validate = options.validateRequests === true;
    this.#validationOptions = options.validationOptions ?? { strict: true, checkTypes: true };
  }

  get willValidateRequest(): boolean {
    return this.#validate;
  }

  set willValidateRequest(value: boolean) {
    this.#validate = value;
  }

  /** Merges options into the validation options used for requests. */
  setValidation(options: MessageValidationOptions): void {
    if (options && Object.keys(options).length > 0) this.#validationOptions = { ...this.#validationOptions, ...options };
  }

  get qos(): QoS {
    return this.#qos;
  }

  get serviceName(): string {
    return this._name;
  }

  /**
   * Publishes request/response events on `<service>/_service_event`
   * (Iron and newer; ignored with a warning on Humble).
   */
  configureIntrospection(clock: Clock, qos: QoS | string, introspectionState: ServiceIntrospectionStates): void {
    this.assertAlive();
    configureIntrospection(
      (c, ts, q, st) => lib.rb_client_configure_introspection(this.handle, c, ts, q, st),
      this.typeClass,
      clock,
      qos,
      introspectionState,
    );
  }

  #send(request: MessageArg<Req>, pending: Pending, validate: boolean | undefined): bigint {
    this.assertAlive();
    if (validate ?? this.#validate) assertValidMessage(request, this.typeClass.request, this.#validationOptions);
    const bytes = this.typeClass.request._encodeTransient(request);
    const seq = checkRc(lib.rb_client_send(this.handle, bytes, bytes.length), `send request to ${this.serviceName}`);
    this.#pending.set(seq, pending);
    return seq;
  }

  /**
   * Sends a request; `callback` receives the response once the node spins. An
   * exception from `callback`, or a response that cannot be decoded, goes to the
   * node's onError handler (kind "client").
   */
  sendRequest(request: MessageArg<Req>, callback: (response: Resp) => void, options: { validate?: boolean } = {}): void {
    this.#send(request, {
      resolve: callback,
      reject: (e) => {
        throw e;
      },
    }, options.validate);
  }

  /** Sends a request and resolves with the response (node must be spinning). */
  sendRequestAsync(request: MessageArg<Req>, options: { timeout?: number; signal?: AbortSignal; validate?: boolean } = {}): Promise<Resp> {
    return new Promise<Resp>((resolve, reject) => {
      if (options.signal?.aborted) return reject(new AbortError("request aborted"));
      const p: Pending = { resolve, reject };
      const seq = this.#send(request, p, options.validate);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        p.cleanup?.();
        this.#pending.delete(seq);
        reject(new AbortError("request aborted"));
      };
      if (options.timeout !== undefined) {
        timer = setTimeout(() => {
          p.cleanup?.();
          this.#pending.delete(seq);
          reject(new TimeoutError(`service ${this.serviceName} did not respond within ${options.timeout} ms`));
        }, options.timeout);
      }
      options.signal?.addEventListener("abort", onAbort, { once: true });
      p.cleanup = () => {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
      };
    });
  }

  isServiceServerAvailable(): boolean {
    return checkRc(lib.rb_client_server_available(this.handle), "service availability") === 1;
  }

  /** Polls until a server is available. Resolves false on timeout (ms); no timeout waits forever. */
  async waitForService(timeout?: number): Promise<boolean> {
    const deadline = timeout === undefined ? Infinity : Date.now() + timeout;
    let delay = 10;
    for (;;) {
      if (this.isDestroyed()) return false;
      if (this.isServiceServerAvailable()) return true;
      const left = deadline - Date.now();
      if (left <= 0) return false;
      await Bun.sleep(Math.min(delay, left));
      delay = Math.min(delay * 2, 1000);
    }
  }

  /** @internal */
  execute(): void {
    // bounded like subscriptions: the wait set wakes us again if more are ready
    for (let i = 0; i < MAX_TAKE; i++) {
      if (this.isDestroyed()) return;
      const n = Number(checkRc(lib.rb_client_take(this.handle, ptr(SEQ), ptr(OUT)), `take response on ${this.serviceName}`));
      if (n === 0) return;
      const view = new Uint8Array(toArrayBuffer(Number(OUT[0]) as Pointer, 0, n));
      const p = this.#pending.get(SEQ[0]!);
      if (!p) continue; // timed out / aborted
      this.#pending.delete(SEQ[0]!);
      p.cleanup?.();
      try {
        p.resolve(convertForDelivery(this.typeClass.response.decode(view), this.options));
      } catch (e) {
        p.reject(e);
      }
    }
  }

  /** @internal */
  _fini(): void {
    if (this.isDestroyed()) return;
    this.markDestroyed();
    for (const p of this.#pending.values()) p.cleanup?.();
    this.#pending.clear();
    lib.rb_client_fini(this.handle);
  }
}
