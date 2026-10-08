// Node: entity factory, graph introspection, spinning, parameters.
import type { Pointer } from "bun:ffi";
import { lib } from "../native/loader.ts";
import { check, checkRc, cstr, cstrArray, json } from "../native/ffi.ts";
import {
  getMessageType,
  getServiceType,
  type MessageType,
  type ServiceType,
  type TypeName,
} from "../interfaces/registry.ts";

const isMessageType = (t: unknown): t is MessageType => typeof t === "object" && t !== null && "encode" in t && "decode" in t;
const isServiceType = (t: unknown): t is ServiceType => typeof t === "object" && t !== null && "request" in t && "response" in t;
const msgType = (t: TypeName | MessageType) => (isMessageType(t) ? t : getMessageType(t));
const srvType = (t: TypeName | ServiceType) => (isServiceType(t) ? t : getServiceType(t));
import { Client } from "./client.ts";
import { Clock, ROSClock } from "./clock.ts";
import { Context } from "./context.ts";
import type { EntityOptions } from "./entity.ts";
import { NameValidationError, OperationError, TypeValidationError } from "./errors.ts";
import { Executor, type Waitable, type WaitableSets } from "./executor.ts";
import type { EventCallbacks } from "./event_handler.ts";
import { Logging } from "./logging.ts";
import { Publisher } from "./publisher.ts";
import { QoS } from "./qos.ts";
import { ServiceResponse, Service, type ServiceRequestHandler } from "./service.ts";
import { Subscription, type SubscriptionCallback } from "./subscription.ts";
import { Time } from "./time.ts";
import { GuardCondition, Rate, Timer, type TimerInfo } from "./timer.ts";
import type { Parameter, ParameterDescriptor } from "./parameter.ts";
import { ParameterManager } from "./parameter_manager.ts";
import { ParameterClient } from "./parameter_client.ts";
import { ParameterEventHandler, ParameterWatcher } from "./parameter_event_handler.ts";
import { TimeSource } from "./time_source.ts";
import type { KnownOr, MessageOf, MessageTypeName, RequestOf, ResponseOf, ServiceTypeName } from "../types.ts";

void ServiceResponse;

export interface NodeOptionsInit {
  startParameterServices?: boolean;
  parameterOverrides?: Parameter[];
  automaticallyDeclareParametersFromOverrides?: boolean;
  enableRosout?: boolean;
  rosoutQos?: QoS | string;
}

export class NodeOptions {
  startParameterServices = true;
  parameterOverrides: Parameter[] = [];
  automaticallyDeclareParametersFromOverrides = false;
  enableRosout = true;
  rosoutQos: QoS | string = QoS.profileRosoutDefault;

  constructor(init: NodeOptionsInit = {}) {
    Object.assign(this, init);
  }

  static get defaultOptions(): NodeOptions {
    return new NodeOptions();
  }
}

export interface NamesAndTypes {
  name: string;
  types: string[];
}

export interface TopicEndpointInfo {
  node_name: string;
  node_namespace: string;
  topic_type: string;
  endpoint_type: number;
  endpoint_gid: number[];
  qos_profile: QoS;
}

type AnyEntity = Publisher | Subscription | Client | Service | Timer | GuardCondition;

export class Node {
  /** @internal */
  handle: Pointer;
  readonly context: Context;
  #destroyed = false;
  #executor: Executor;
  #logger: Logging;
  #clock: ROSClock;
  #options: NodeOptions;

  #publishers = new Set<Publisher>();
  #subscriptions = new Set<Subscription>();
  #clients = new Set<Client>();
  #services = new Set<Service>();
  #timers = new Set<Timer>();
  #guards = new Set<GuardCondition>();
  /** Extra waitables registered by higher-level constructs (e.g. actions). */
  #waitables = new Set<{ sets(): Partial<WaitableSets> }>();
  /** @internal */
  readonly _parameters: ParameterManager;
  /** @internal */
  readonly _timeSource: TimeSource;

  constructor(
    name: string,
    namespace = "",
    context: Context = Context.defaultContext(),
    options: NodeOptions | NodeOptionsInit = new NodeOptions(),
    args: string[] = [],
    useGlobalArguments = true,
  ) {
    if (typeof name !== "string") throw new TypeValidationError("node name must be a string");
    if (!context.isInitialized()) throw new OperationError("context is not initialized; call rclbun.init() first");
    this.context = context;
    this.#options = options instanceof NodeOptions ? options : new NodeOptions(options);
    const nameErr = lib.rb_validate_node_name(cstr(name));
    if (nameErr) throw new NameValidationError(`invalid node name '${name}': ${nameErr}`);
    const a = cstrArray(args.length && args[0] !== "--ros-args" ? ["--ros-args", ...args] : args);
    this.handle = check(
      lib.rb_node_init(context.handle, cstr(name), cstr(namespace), useGlobalArguments ? 1 : 0, this.#options.enableRosout ? 1 : 0, a.argc, a.argv),
      "rcl_node_init",
    );
    void a.keep;
    this.#logger = new Logging(String(lib.rb_node_logger_name(this.handle)));
    this.#clock = new ROSClock();
    this.#executor = new Executor(() => this.context.handle, () => this.#collect());
    context.addNode(this);
    this._parameters = new ParameterManager(this, this.#options);
    this._timeSource = new TimeSource(this);
    this._timeSource.attachClock(this.#clock);
    this._parameters.init();
    this._timeSource.init();
  }

  static getDefaultOptions(): EntityOptions & { enableTypedArray: boolean; isRaw: boolean; qos: string } {
    return { enableTypedArray: true, isRaw: false, qos: QoS.profileDefault, serializationMode: "default" };
  }

  // ---- identity -------------------------------------------------------------

  name(): string {
    return String(lib.rb_node_name(this.handle));
  }

  namespace(): string {
    return String(lib.rb_node_namespace(this.handle));
  }

  getFullyQualifiedName(): string {
    return String(lib.rb_node_fqn(this.handle));
  }

  getLogger(): Logging {
    return this.#logger;
  }

  getClock(): ROSClock {
    return this.#clock;
  }

  now(): Time {
    return this.#clock.now();
  }

  get options(): NodeOptions {
    return this.#options;
  }

  getRMWImplementationIdentifier(): string {
    return String(lib.rb_rmw_implementation());
  }

  resolveTopicName(topic: string, onlyExpand = false): string {
    const r = lib.rb_node_resolve_name(this.handle, cstr(topic), 0, onlyExpand ? 1 : 0);
    if (r === null) throw new NameValidationError(`cannot resolve topic name '${topic}'`);
    return String(r);
  }

  resolveServiceName(service: string, onlyExpand = false): string {
    const r = lib.rb_node_resolve_name(this.handle, cstr(service), 1, onlyExpand ? 1 : 0);
    if (r === null) throw new NameValidationError(`cannot resolve service name '${service}'`);
    return String(r);
  }

  isDestroyed(): boolean {
    return this.#destroyed;
  }

  #assertAlive(): void {
    if (this.#destroyed) throw new OperationError("node has been destroyed");
  }

  // ---- entities -------------------------------------------------------------

  #entityOptions(options: EntityOptions | undefined): EntityOptions {
    return { ...Node.getDefaultOptions(), ...(options ?? {}) };
  }

  #added(): void {
    this.#executor.notify();
  }

  createPublisher<K extends KnownOr<MessageTypeName>, T = MessageOf<K>>(
    typeClass: K | MessageType | Exclude<TypeName, string>,
    topic: string,
    options?: EntityOptions,
    eventCallbacks?: EventCallbacks,
  ): Publisher<T> {
    this.#assertAlive();
    const p = new Publisher<T>(this.handle, this.#logger.name, msgType(typeClass), topic, this.#entityOptions(options), eventCallbacks);
    this.#publishers.add(p);
    if (p._events.length) this.#added();
    return p;
  }

  /** @internal registers a publisher built by a subclass (e.g. lifecycle publishers) */
  _adoptPublisher<P extends Publisher>(make: (nodeHandle: Pointer, loggerName: string) => P): P {
    this.#assertAlive();
    const p = make(this.handle, this.#logger.name);
    this.#publishers.add(p);
    return p;
  }

  createSubscription<K extends KnownOr<MessageTypeName>, T = MessageOf<K>>(
    typeClass: K | MessageType | Exclude<TypeName, string>,
    topic: string,
    callback: SubscriptionCallback<T>,
  ): Subscription<T>;
  createSubscription<K extends KnownOr<MessageTypeName>, T = MessageOf<K>>(
    typeClass: K | MessageType | Exclude<TypeName, string>,
    topic: string,
    options: EntityOptions | undefined,
    callback: SubscriptionCallback<T>,
    eventCallbacks?: EventCallbacks,
  ): Subscription<T>;
  createSubscription<T = any>(
    typeClass: TypeName | MessageType,
    topic: string,
    optionsOrCb: EntityOptions | SubscriptionCallback<T> | undefined,
    cb?: SubscriptionCallback<T>,
    eventCallbacks?: EventCallbacks,
  ): Subscription<T> {
    this.#assertAlive();
    const [options, callback] = typeof optionsOrCb === "function" ? [undefined, optionsOrCb] : [optionsOrCb, cb];
    if (typeof callback !== "function") throw new TypeValidationError("subscription callback must be a function");
    const s = new Subscription<T>(this.handle, this.#logger.name, msgType(typeClass), topic, this.#entityOptions(options), callback, eventCallbacks);
    s._quiesce = () => this.#executor.quiesce();
    this.#subscriptions.add(s);
    this.#added();
    return s;
  }

  createClient<K extends KnownOr<ServiceTypeName>, Req = RequestOf<K>, Resp = ResponseOf<K>>(
    typeClass: K | ServiceType | Exclude<TypeName, string>,
    serviceName: string,
    options?: EntityOptions,
  ): Client<Req, Resp> {
    this.#assertAlive();
    const c = new Client<Req, Resp>(this.handle, this.#logger.name, srvType(typeClass), serviceName, this.#entityOptions(options));
    this.#clients.add(c);
    this.#added();
    return c;
  }

  createService<K extends KnownOr<ServiceTypeName>, Req = RequestOf<K>, Resp = ResponseOf<K>>(
    typeClass: K | ServiceType | Exclude<TypeName, string>,
    serviceName: string,
    handler: ServiceRequestHandler<Req, Resp>,
  ): Service<Req, Resp>;
  createService<K extends KnownOr<ServiceTypeName>, Req = RequestOf<K>, Resp = ResponseOf<K>>(
    typeClass: K | ServiceType | Exclude<TypeName, string>,
    serviceName: string,
    options: EntityOptions | undefined,
    handler: ServiceRequestHandler<Req, Resp>,
  ): Service<Req, Resp>;
  createService<Req = any, Resp = any>(
    typeClass: TypeName | ServiceType,
    serviceName: string,
    optionsOrHandler: EntityOptions | ServiceRequestHandler<Req, Resp> | undefined,
    h?: ServiceRequestHandler<Req, Resp>,
  ): Service<Req, Resp> {
    this.#assertAlive();
    const [options, handler] = typeof optionsOrHandler === "function" ? [undefined, optionsOrHandler] : [optionsOrHandler, h];
    if (typeof handler !== "function") throw new TypeValidationError("service handler must be a function");
    const s = new Service<Req, Resp>(this.handle, this.#logger.name, srvType(typeClass), serviceName, this.#entityOptions(options), handler);
    this.#services.add(s);
    this.#added();
    return s;
  }

  createTimer(
    period: bigint,
    callback: (info?: TimerInfo) => void,
    optionsOrClock?: { autostart?: boolean } | Clock | null,
    clock?: Clock | null,
  ): Timer {
    this.#assertAlive();
    let autostart = true;
    let clk: Clock = this.#clock;
    if (optionsOrClock instanceof Clock) clk = optionsOrClock;
    else if (optionsOrClock && typeof optionsOrClock === "object") autostart = optionsOrClock.autostart !== false;
    if (clock) clk = clock;
    const t = new Timer(this.context.handle!, clk, period, callback, autostart);
    this.#timers.add(t);
    this.#added();
    return t;
  }

  async createRate(hz = 1): Promise<Rate> {
    return new Rate(hz);
  }

  createParameterClient(remoteNodeName: string, options: { timeout?: number } = {}): ParameterClient {
    this.#assertAlive();
    return new ParameterClient(this, remoteNodeName, options);
  }

  destroyParameterClient(pc: ParameterClient): void {
    pc.destroy();
  }

  createParameterEventHandler(options: { qos?: QoS | string } = {}): ParameterEventHandler {
    this.#assertAlive();
    return new ParameterEventHandler(this, options);
  }

  destroyParameterEventHandler(h: ParameterEventHandler): void {
    h.destroy();
  }

  createParameterWatcher(remoteNodeName: string, names: string[], options: { timeout?: number } = {}): ParameterWatcher {
    this.#assertAlive();
    return new ParameterWatcher(this, remoteNodeName, names, options);
  }

  destroyParameterWatcher(w: ParameterWatcher): void {
    w.destroy();
  }

  createGuardCondition(callback: () => unknown): GuardCondition {
    this.#assertAlive();
    const g = new GuardCondition(this.context.handle!, callback);
    this.#guards.add(g);
    this.#added();
    return g;
  }

  /** @internal registers a provider of additional waitables (actions, etc.) */
  _addWaitables(w: { sets(): Partial<WaitableSets> }): void {
    this.#waitables.add(w);
    this.#added();
  }

  /** @internal */
  _removeWaitables(w: { sets(): Partial<WaitableSets> }): void {
    this.#executor.quiesce();
    this.#waitables.delete(w);
  }

  /** @internal finalizes an entity safely w.r.t. the wait thread */
  _finiEntity(e: AnyEntity): void {
    this.#executor.quiesce();
    e._fini();
  }

  #destroyEntity(set: Set<any>, e: AnyEntity | undefined): void {
    if (!e || !set.has(e)) return;
    set.delete(e);
    this._finiEntity(e);
  }

  destroyPublisher(p: Publisher): void { this.#destroyEntity(this.#publishers, p); }
  destroySubscription(s: Subscription): void { this.#destroyEntity(this.#subscriptions, s); }
  destroyClient(c: Client): void { this.#destroyEntity(this.#clients, c); }
  destroyService(s: Service): void { this.#destroyEntity(this.#services, s); }
  destroyTimer(t: Timer): void { this.#destroyEntity(this.#timers, t); }
  destroyGuardCondition(g: GuardCondition): void { this.#destroyEntity(this.#guards, g); }

  #collect(): WaitableSets {
    const sets: WaitableSets = {
      subscriptions: [...this.#subscriptions],
      guards: [...this.#guards],
      timers: [...this.#timers],
      clients: [...this.#clients],
      services: [...this.#services],
      events: [...this.#publishers, ...this.#subscriptions].flatMap((e) => e._events),
    };
    for (const w of this.#waitables) {
      const extra = w.sets();
      for (const k of Object.keys(extra) as (keyof WaitableSets)[]) sets[k].push(...((extra[k] ?? []) as Waitable[]));
    }
    return sets;
  }

  // ---- spinning ---------------------------------------------------------------

  get spinning(): boolean {
    return this.#executor.spinning;
  }

  /** Starts processing callbacks in the background (non-blocking). */
  spin(_timeout = 10): void {
    this.#assertAlive();
    this.#executor.start();
  }

  /** Waits up to `timeout` ms (blocking) and processes ready callbacks once. */
  spinOnce(timeout = 10): void {
    this.#assertAlive();
    this.#executor.spinOnce(BigInt(Math.max(0, Math.round(timeout))) * 1_000_000n);
  }

  stop(): void {
    this.#executor.stop();
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#executor.destroy();
    this._timeSource.detachNode();
    this._parameters.destroy();
    for (const set of [this.#subscriptions, this.#publishers, this.#clients, this.#services, this.#timers, this.#guards] as Set<AnyEntity>[]) {
      for (const e of set) e._fini();
      set.clear();
    }
    this.#destroyed = true;
    lib.rb_node_fini(this.handle);
    this.context.removeNode(this);
  }

  // ---- graph ------------------------------------------------------------------

  getTopicNamesAndTypes(noDemangle = false): NamesAndTypes[] {
    return json(lib.rb_graph_names_and_types(this.handle, 0, null, null, noDemangle ? 1 : 0), "topic names and types");
  }

  getServiceNamesAndTypes(): NamesAndTypes[] {
    return json(lib.rb_graph_names_and_types(this.handle, 1, null, null, 0), "service names and types");
  }

  #byNode(kind: number, nodeName: string, namespace = "/", noDemangle = false): NamesAndTypes[] {
    return json(lib.rb_graph_names_and_types(this.handle, kind, cstr(nodeName), cstr(namespace), noDemangle ? 1 : 0), "names and types by node");
  }

  getPublisherNamesAndTypesByNode(nodeName: string, namespace?: string, noDemangle = false): NamesAndTypes[] {
    return this.#byNode(2, nodeName, namespace, noDemangle);
  }

  getSubscriptionNamesAndTypesByNode(nodeName: string, namespace?: string, noDemangle = false): NamesAndTypes[] {
    return this.#byNode(3, nodeName, namespace, noDemangle);
  }

  getServiceNamesAndTypesByNode(nodeName: string, namespace?: string): NamesAndTypes[] {
    return this.#byNode(4, nodeName, namespace);
  }

  getClientNamesAndTypesByNode(nodeName: string, namespace?: string): NamesAndTypes[] {
    return this.#byNode(5, nodeName, namespace);
  }

  getNodeNames(): string[] {
    return this.getNodeNamesAndNamespaces().map((n) => n.name);
  }

  getNodeNamesAndNamespaces(): { name: string; namespace: string }[] {
    return json(lib.rb_graph_node_names(this.handle, 0), "node names");
  }

  getNodeNamesAndNamespacesWithEnclaves(): { name: string; namespace: string; enclave: string }[] {
    return json(lib.rb_graph_node_names(this.handle, 1), "node names");
  }

  #count(kind: number, name: string): number {
    return Number(checkRc(lib.rb_graph_count(this.handle, kind, cstr(name)), "graph count"));
  }

  countPublishers(topic: string): number { return this.#count(0, this.resolveTopicName(topic)); }
  countSubscribers(topic: string): number { return this.#count(1, this.resolveTopicName(topic)); }
  countClients(service: string): number { return this.#count(2, this.resolveServiceName(service)); }
  countServices(service: string): number { return this.#count(3, this.resolveServiceName(service)); }

  #endpoints(kind: number, topic: string, noDemangle: boolean): TopicEndpointInfo[] {
    const raw = json<any[]>(lib.rb_graph_endpoint_info(this.handle, kind, cstr(this.resolveTopicName(topic)), noDemangle ? 1 : 0), "endpoint info");
    return raw.map((e) => ({
      node_name: e.nodeName,
      node_namespace: e.nodeNamespace,
      topic_type: e.topicType,
      endpoint_type: e.endpointType,
      endpoint_gid: e.gid,
      qos_profile: QoS.fromJSON(e.qos),
    }));
  }

  getPublishersInfoByTopic(topic: string, noDemangle = false): TopicEndpointInfo[] {
    return this.#endpoints(0, topic, noDemangle);
  }

  getSubscriptionsInfoByTopic(topic: string, noDemangle = false): TopicEndpointInfo[] {
    return this.#endpoints(1, topic, noDemangle);
  }

  // ---- parameters (see parameter_manager.ts) ---------------------------------

  declareParameter(p: Parameter, d?: ParameterDescriptor, ignoreOverride = false): Parameter {
    return this._parameters.declareParameter(p, d, ignoreOverride);
  }
  declareParameters(ps: Parameter[], ds?: ParameterDescriptor[], ignoreOverrides = false): Parameter[] {
    return this._parameters.declareParameters(ps, ds, ignoreOverrides);
  }
  undeclareParameter(name: string): void { this._parameters.undeclareParameter(name); }
  hasParameter(name: string): boolean { return this._parameters.hasParameter(name); }
  getParameter(name: string): Parameter { return this._parameters.getParameter(name); }
  getParameters(names: string[] = []): Parameter[] { return this._parameters.getParameters(names); }
  getParameterNames(): string[] { return this._parameters.getParameterNames(); }
  getParameterOverrides(): Parameter[] { return this._parameters.getParameterOverrides(); }
  hasParameterDescriptor(name: string): boolean { return this._parameters.hasParameterDescriptor(name); }
  getParameterDescriptor(name: string): ParameterDescriptor { return this._parameters.getParameterDescriptor(name); }
  getParameterDescriptors(names: string[] = []): ParameterDescriptor[] { return this._parameters.getParameterDescriptors(names); }
  setParameter(p: Parameter) { return this._parameters.setParameter(p); }
  setParameters(ps: Parameter[]) { return this._parameters.setParameters(ps); }
  setParametersAtomically(ps: Parameter[]) { return this._parameters.setParametersAtomically(ps); }
  addOnSetParametersCallback(cb: (ps: Parameter[]) => { successful: boolean; reason?: string }): void {
    this._parameters.addOnSetParametersCallback(cb);
  }
  removeOnSetParametersCallback(cb: (ps: Parameter[]) => { successful: boolean; reason?: string }): void {
    this._parameters.removeOnSetParametersCallback(cb);
  }
  addPreSetParametersCallback(cb: (ps: Parameter[]) => Parameter[]): void { this._parameters.addPreSetParametersCallback(cb); }
  removePreSetParametersCallback(cb: (ps: Parameter[]) => Parameter[]): void { this._parameters.removePreSetParametersCallback(cb); }
  addPostSetParametersCallback(cb: (ps: Parameter[]) => void): void { this._parameters.addPostSetParametersCallback(cb); }
  removePostSetParametersCallback(cb: (ps: Parameter[]) => void): void { this._parameters.removePostSetParametersCallback(cb); }
}
