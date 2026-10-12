// Callbacks on /parameter_events (rclcpp ParameterEventHandler / rclnodejs equivalent)
// and a watcher for selected parameters of a remote node.
import { EventEmitter } from "node:events";
import type { Node } from "./node.ts";
import { Parameter } from "./parameter.ts";
import type { ParameterClient } from "./parameterClient.ts";
import { QoS } from "./qos.ts";
import type { Subscription } from "./subscription.ts";

export interface ParameterEvent {
  stamp: { sec: number; nanosec: number };
  node: string;
  new_parameters: { name: string; value: any }[];
  changed_parameters: { name: string; value: any }[];
  deleted_parameters: { name: string; value: any }[];
}

export interface ParameterCallbackHandle {
  parameterName: string;
  nodeName: string;
  callback: (p: Parameter) => void;
}

export interface ParameterEventCallbackHandle {
  callback: (e: ParameterEvent) => void;
}

const abs = (n: string) => (n.startsWith("/") ? n : `/${n}`);

export class ParameterEventHandler {
  #node: Node;
  #sub: Subscription | undefined;
  #paramCallbacks: ParameterCallbackHandle[] = [];
  #eventCallbacks: ParameterEventCallbackHandle[] = [];
  #nodesFilter: Set<string> | undefined;

  constructor(node: Node, options: { qos?: QoS | string } = {}) {
    this.#node = node;
    this.#sub = node.createSubscription("rcl_interfaces/msg/ParameterEvent", "/parameter_events", { qos: options.qos ?? QoS.profileParameterEvents }, (e: any) =>
      this.#dispatch(e as ParameterEvent),
    );
  }

  #dispatch(e: ParameterEvent): void {
    if (this.#nodesFilter && !this.#nodesFilter.has(e.node)) return;
    for (const h of [...this.#eventCallbacks]) h.callback(e);
    for (const h of [...this.#paramCallbacks]) {
      if (h.nodeName !== e.node) continue;
      const p = ParameterEventHandler.getParameterFromEvent(e, h.parameterName, h.nodeName);
      if (p) h.callback(p);
    }
  }

  /** Calls `cb` when `name` on node `nodeName` is added or changed. */
  addParameterCallback(name: string, nodeName: string, cb: (p: Parameter) => void): ParameterCallbackHandle {
    const h = { parameterName: name, nodeName: abs(nodeName), callback: cb };
    this.#paramCallbacks.unshift(h);
    return h;
  }

  removeParameterCallback(h: ParameterCallbackHandle): void {
    this.#paramCallbacks = this.#paramCallbacks.filter((x) => x !== h);
  }

  addParameterEventCallback(cb: (e: ParameterEvent) => void): ParameterEventCallbackHandle {
    const h = { callback: cb };
    this.#eventCallbacks.unshift(h);
    return h;
  }

  removeParameterEventCallback(h: ParameterEventCallbackHandle): void {
    this.#eventCallbacks = this.#eventCallbacks.filter((x) => x !== h);
  }

  /** Only deliver events from these nodes (undefined/empty clears the filter). */
  configureNodesFilter(nodeNames?: string[]): boolean {
    this.#nodesFilter = nodeNames?.length ? new Set(nodeNames.map(abs)) : undefined;
    return true;
  }

  static getParameterFromEvent(e: ParameterEvent, name: string, nodeName: string): Parameter | undefined {
    if (e.node !== abs(nodeName)) return undefined;
    const m = [...e.new_parameters, ...e.changed_parameters].find((p) => p.name === name);
    return m ? Parameter.fromParameterMessage(m) : undefined;
  }

  static getParametersFromEvent(e: ParameterEvent): Parameter[] {
    return [...e.new_parameters, ...e.changed_parameters].map((m) => Parameter.fromParameterMessage(m));
  }

  isDestroyed(): boolean {
    return this.#sub === undefined;
  }

  destroy(): void {
    if (this.#sub && !this.#node.isDestroyed()) this.#node.destroySubscription(this.#sub);
    this.#sub = undefined;
  }
}

/** Emits 'change' with the changed Parameter[] of the watched parameters on a remote node. */
export class ParameterWatcher extends EventEmitter {
  readonly remoteNodeName: string;
  #names: Set<string>;
  #client: ParameterClient;
  #handler: ParameterEventHandler;
  #handle: ParameterEventCallbackHandle | undefined;

  constructor(node: Node, remoteNodeName: string, names: string[], options: { timeout?: number } = {}) {
    super();
    this.remoteNodeName = abs(remoteNodeName);
    this.#names = new Set(names);
    this.#client = node.createParameterClient(this.remoteNodeName, options);
    this.#handler = new ParameterEventHandler(node);
  }

  get watchedParameters(): string[] {
    return [...this.#names];
  }

  async start(timeout?: number): Promise<boolean> {
    if (!(await this.#client.waitForService(timeout))) return false;
    this.#handle ??= this.#handler.addParameterEventCallback((e) => {
      if (e.node !== this.remoteNodeName) return;
      const changed = ParameterEventHandler.getParametersFromEvent(e).filter((p) => this.#names.has(p.name));
      if (changed.length) this.emit("change", changed);
    });
    return true;
  }

  getCurrentValues(o: { timeout?: number; signal?: AbortSignal } = {}): Promise<Parameter[]> {
    return this.#client.getParameters([...this.#names], o);
  }

  addParameter(name: string): void {
    this.#names.add(name);
  }

  removeParameter(name: string): boolean {
    return this.#names.delete(name);
  }

  isDestroyed(): boolean {
    return this.#handler.isDestroyed();
  }

  destroy(): void {
    this.#handler.destroy();
    this.#client.destroy();
    this.removeAllListeners();
  }
}
