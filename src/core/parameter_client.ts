// Client for another node's parameter services.
import type { Client } from "./client.ts";
import type { Node } from "./node.ts";
import { Parameter, ParameterDescriptor, ParameterType, inferParameterType } from "./parameter.ts";
import { QoS } from "./qos.ts";

export interface CallOptions {
  timeout?: number;
  signal?: AbortSignal;
}

const SERVICES = {
  get: ["GetParameters", "get_parameters"],
  types: ["GetParameterTypes", "get_parameter_types"],
  describe: ["DescribeParameters", "describe_parameters"],
  list: ["ListParameters", "list_parameters"],
  set: ["SetParameters", "set_parameters"],
  setAtomic: ["SetParametersAtomically", "set_parameters_atomically"],
} as const;

export class ParameterClient {
  readonly remoteNodeName: string;
  #node: Node;
  #clients: Record<keyof typeof SERVICES, Client>;
  #timeout: number | undefined;
  #destroyed = false;

  constructor(node: Node, remoteNodeName: string, options: { timeout?: number } = {}) {
    this.#node = node;
    this.remoteNodeName = remoteNodeName.replace(/\/$/, "");
    this.#timeout = options.timeout;
    const base = this.remoteNodeName.startsWith("/") ? this.remoteNodeName : `/${this.remoteNodeName}`;
    const make = ([type, name]: readonly [string, string]) =>
      node.createClient(`rcl_interfaces/srv/${type}`, `${base}/${name}`, { qos: QoS.profileServicesDefault });
    this.#clients = {
      get: make(SERVICES.get),
      types: make(SERVICES.types),
      describe: make(SERVICES.describe),
      list: make(SERVICES.list),
      set: make(SERVICES.set),
      setAtomic: make(SERVICES.setAtomic),
    };
  }

  #call(which: keyof typeof SERVICES, req: unknown, o: CallOptions = {}): Promise<any> {
    return this.#clients[which].sendRequestAsync(req, { timeout: o.timeout ?? this.#timeout, signal: o.signal });
  }

  async waitForService(timeout?: number): Promise<boolean> {
    const rs = await Promise.all(Object.values(this.#clients).map((c) => c.waitForService(timeout)));
    return rs.every(Boolean);
  }

  async getParameters(names: string[], o?: CallOptions): Promise<Parameter[]> {
    const r = await this.#call("get", { names }, o);
    return (r.values as any[]).map((v, i) => new Parameter(names[i]!, v.type, Parameter.valueFromMessage(v)));
  }

  async getParameter(name: string, o?: CallOptions): Promise<Parameter> {
    return (await this.getParameters([name], o))[0]!;
  }

  async getParameterTypes(names: string[], o?: CallOptions): Promise<ParameterType[]> {
    const r = await this.#call("types", { names }, o);
    return Array.from(r.types as ArrayLike<number>);
  }

  async describeParameters(names: string[], o?: CallOptions): Promise<ParameterDescriptor[]> {
    const r = await this.#call("describe", { names }, o);
    return (r.descriptors as any[]).map((d) => ParameterDescriptor.fromMessage(d));
  }

  async listParameters(o: CallOptions & { prefixes?: string[]; depth?: number } = {}): Promise<{ names: string[]; prefixes: string[] }> {
    const r = await this.#call("list", { prefixes: o.prefixes ?? [], depth: BigInt(o.depth ?? 0) }, o);
    return r.result;
  }

  async #toParameters(items: { name: string; value: unknown }[], o?: CallOptions): Promise<Parameter[]> {
    const types = await this.getParameterTypes(items.map((i) => i.name), o);
    return items.map((it, i) => {
      let t = types[i] ?? ParameterType.PARAMETER_NOT_SET;
      if (t === ParameterType.PARAMETER_NOT_SET) t = inferParameterType(it.value);
      return new Parameter(it.name, t, it.value);
    });
  }

  async setParameters(items: { name: string; value: unknown }[], o?: CallOptions): Promise<{ name: string; successful: boolean; reason: string }[]> {
    const ps = await this.#toParameters(items, o);
    const r = await this.#call("set", { parameters: ps.map((p) => p.toParameterMessage()) }, o);
    return (r.results as any[]).map((x, i) => ({ name: items[i]!.name, successful: x.successful, reason: x.reason }));
  }

  async setParameter(name: string, value: unknown, o?: CallOptions): Promise<{ name: string; successful: boolean; reason: string }> {
    return (await this.setParameters([{ name, value }], o))[0]!;
  }

  async setParametersAtomically(items: { name: string; value: unknown }[], o?: CallOptions): Promise<{ successful: boolean; reason: string }> {
    const ps = await this.#toParameters(items, o);
    const r = await this.#call("setAtomic", { parameters: ps.map((p) => p.toParameterMessage()) }, o);
    return r.result;
  }

  isDestroyed(): boolean {
    return this.#destroyed;
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    if (this.#node.isDestroyed()) return;
    for (const c of Object.values(this.#clients)) this.#node.destroyClient(c);
  }
}
