import { ptr, toArrayBuffer, type Pointer } from "bun:ffi";
import { features, lib } from "../native/loader.ts";
import { check, checkRc, cstr, lastError } from "../native/ffi.ts";
import type { ServiceType } from "../interfaces/registry.ts";
import { convertForDelivery, Entity, type EntityOptions } from "./entity.ts";
import { NativeError } from "./errors.ts";
import type { Waitable } from "./executor.ts";
import { Logging } from "./logging.ts";
import { QoS } from "./qos.ts";
import type { MessageInput } from "../types.ts";
import type { Clock } from "./clock.ts";

const OUT = new BigUint64Array(1);
const HDR = new BigUint64Array(1);
// Requests taken per wake-up before yielding back to the event loop.
const MAX_TAKE = 256;

/** What service introspection publishes on `<service>/_service_event`. */
export enum ServiceIntrospectionStates {
  OFF = 0,
  METADATA = 1,
  CONTENTS = 2,
}

/** @internal shared by Service and Client */
export function configureIntrospection(
  configure: (clock: Pointer, ts: Pointer, qos: BigInt64Array, state: number) => number,
  srvType: ServiceType,
  clock: Clock,
  qos: QoS | string,
  state: ServiceIntrospectionStates,
): void {
  if (!features.serviceIntrospection) {
    console.warn("Service introspection is not supported by this version of ROS 2");
    return;
  }
  const q = QoS.from(qos, QoS.profileSystemDefault);
  if (configure(clock.handle, srvType.typeSupport(), q.toNative(), state) !== 0) {
    throw new NativeError(`configure service introspection: ${lastError()}`);
  }
}

// Frees the request header of a ServiceResponse that was never sent.
const unanswered = new FinalizationRegistry<Pointer>((h) => lib.rb_free(h));

/** Handed to the request handler; send() replies to that request. */
export class ServiceResponse<Resp = any> {
  #service: Service;
  #header: Pointer | null;
  readonly template: Resp;

  constructor(service: Service, header: Pointer) {
    this.#service = service;
    this.#header = header;
    this.template = service.typeClass.response.create();
    unanswered.register(this, header, this);
  }

  get service(): Service {
    return this.#service;
  }

  get sent(): boolean {
    return this.#header === null;
  }

  send(response: MessageInput<Resp>): void {
    const h = this.#header;
    if (h === null) throw new Error("response already sent");
    this.#header = null;
    unanswered.unregister(this);
    this.#service._reply(h, response);
  }
}

export type ServiceRequestHandler<Req, Resp> = (
  request: Req,
  response: ServiceResponse<Resp>,
) => MessageInput<Resp> | void | Promise<MessageInput<Resp> | void>;

export class Service<Req = any, Resp = any> extends Entity implements Waitable {
  readonly typeClass: ServiceType;
  readonly loggerName: string;
  readonly #handler: ServiceRequestHandler<Req, Resp>;
  readonly #qos: QoS;

  /** @internal */
  constructor(
    nodeHandle: Pointer,
    loggerName: string,
    srvType: ServiceType,
    serviceName: string,
    options: EntityOptions,
    handler: ServiceRequestHandler<Req, Resp>,
  ) {
    const qos = QoS.from(options.qos, QoS.profileServicesDefault);
    const h = check(
      lib.rb_service_init(
        nodeHandle,
        srvType.typeSupport(),
        cstr(serviceName),
        qos.toNative(),
        srvType.request.typeSupport(),
        srvType.response.typeSupport(),
      ),
      `create service '${serviceName}'`,
    );
    super(h, options);
    this.typeClass = srvType;
    this.loggerName = loggerName;
    this.#handler = handler;
    this.#qos = qos;
  }

  get qos(): QoS {
    return this.#qos;
  }

  get serviceName(): string {
    return String(lib.rb_service_name(this.handle));
  }

  getOptions(): EntityOptions {
    return this.options;
  }

  /**
   * Publishes request/response events on `<service>/_service_event`
   * (Iron and newer; ignored with a warning on Humble).
   */
  configureIntrospection(clock: Clock, qos: QoS | string, introspectionState: ServiceIntrospectionStates): void {
    this.assertAlive();
    configureIntrospection(
      (c, ts, q, st) => lib.rb_service_configure_introspection(this.handle, c, ts, q, st),
      this.typeClass,
      clock,
      qos,
      introspectionState,
    );
  }

  /** @internal */
  _reply(header: Pointer, response: MessageInput<Resp>): void {
    if (this.isDestroyed()) {
      lib.rb_free(header);
      return;
    }
    let bytes: Uint8Array;
    try {
      bytes = this.typeClass.response._encodeTransient(response);
    } catch (e) {
      lib.rb_free(header);
      throw e;
    }
    if (lib.rb_service_send(this.handle, header, bytes, bytes.length) !== 0) {
      throw new NativeError(`send response on ${this.serviceName}: ${lastError()}`);
    }
  }

  /** @internal */
  execute(): void {
    // bounded like subscriptions: the wait set wakes us again if more are ready
    for (let i = 0; i < MAX_TAKE; i++) {
      if (this.isDestroyed()) return;
      const n = Number(checkRc(lib.rb_service_take(this.handle, ptr(HDR), ptr(OUT)), `take request on ${this.serviceName}`));
      if (n === 0) return;
      const header = Number(HDR[0]) as Pointer;
      const view = new Uint8Array(toArrayBuffer(Number(OUT[0]) as Pointer, 0, n));
      let request: Req;
      try {
        request = convertForDelivery(this.typeClass.request.decode(view), this.options) as Req;
      } catch (e) {
        lib.rb_free(header);
        throw e;
      }
      const response = new ServiceResponse<Resp>(this, header);
      const fail = (e: unknown) => Logging.getLogger(this.loggerName).error(`service ${this.serviceName} handler failed: ${String((e as Error)?.stack ?? e)}`);
      try {
        const r = this.#handler(request, response);
        if (r instanceof Promise) {
          r.then((v) => {
            if (!response.sent && v !== undefined) response.send(v);
          }, fail);
        } else if (!response.sent && r !== undefined) {
          response.send(r);
        }
      } catch (e) {
        fail(e);
      }
    }
  }

  /** @internal */
  _fini(): void {
    if (this.isDestroyed()) return;
    this.markDestroyed();
    lib.rb_service_fini(this.handle);
  }
}
