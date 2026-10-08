// Per-node parameter store: declaration, overrides, set callbacks,
// /parameter_events and the standard parameter services.
import { lib } from "../native/loader.ts";
import { json } from "../native/ffi.ts";
import { ParameterError, ParameterNotFoundError, ParameterTypeError, ReadOnlyParameterError, TypeValidationError } from "./errors.ts";
import type { Node, NodeOptions } from "./node.ts";
import { Parameter, ParameterDescriptor, ParameterType } from "./parameter.ts";
import type { Publisher } from "./publisher.ts";
import { QoS } from "./qos.ts";

export interface SetParametersResult {
  successful: boolean;
  reason: string;
}

type OnSet = (ps: Parameter[]) => { successful: boolean; reason?: string };
type PreSet = (ps: Parameter[]) => Parameter[];
type PostSet = (ps: Parameter[]) => void;

/** '/a/*' style patterns from YAML: '*' = one segment, '**' = any number of segments. */
function nodeMatches(pattern: string, fqn: string): boolean {
  const p = pattern.startsWith("/") ? pattern : `/${pattern}`;
  if (p === "/**") return true;
  const re = new RegExp(
    "^" +
      p
        .split("/")
        .map((seg) => (seg === "**" ? "(?:/[^/]+)*" : seg === "*" ? "/[^/]+" : seg ? `/${seg.replace(/[.+?^${}()|[\]\\]/g, "\\$&")}` : ""))
        .join("") +
      "$",
  );
  return re.test(fqn);
}

export class ParameterManager {
  #node: Node;
  #options: NodeOptions;
  #params = new Map<string, Parameter>();
  #descriptors = new Map<string, ParameterDescriptor>();
  #overrides = new Map<string, Parameter>();
  #onSet: OnSet[] = [];
  #preSet: PreSet[] = [];
  #postSet: PostSet[] = [];
  #events: Publisher | undefined;
  #services: unknown[] = [];

  constructor(node: Node, options: NodeOptions) {
    this.#node = node;
    this.#options = options;
  }

  init(): void {
    this.#loadOverrides();
    this.#events = this.#node.createPublisher("rcl_interfaces/msg/ParameterEvent", "/parameter_events", {
      qos: QoS.profileParameterEvents,
    });
    if (this.#options.startParameterServices) this.#startServices();
    if (this.#options.automaticallyDeclareParametersFromOverrides) {
      for (const p of this.#overrides.values()) {
        if (!this.#params.has(p.name)) this.declareParameter(p);
      }
    }
  }

  destroy(): void {
    this.#events = undefined;
    this.#services = [];
  }

  #loadOverrides(): void {
    const fqn = this.#node.getFullyQualifiedName();
    const raw = json<Record<string, any>>(lib.rb_node_param_overrides(this.#node.context.handle, this.#node.handle), "parameter overrides");
    const apply = (byNode: Record<string, Record<string, { type: string; value: unknown }>>) => {
      // wildcard entries first so that exact matches win
      const keys = Object.keys(byNode).sort((a, b) => Number(!a.includes("*")) - Number(!b.includes("*")));
      for (const key of keys) {
        if (!nodeMatches(key, fqn)) continue;
        for (const [name, v] of Object.entries(byNode[key]!)) this.#overrides.set(name, Parameter.fromOverride(name, v));
      }
    };
    const { __node_local__: local, ...global } = raw;
    apply(global);
    if (local) apply(local);
    for (const p of this.#options.parameterOverrides ?? []) this.#overrides.set(p.name, p);
  }

  getParameterOverrides(): Parameter[] {
    return [...this.#overrides.values()];
  }

  // ---- declare / query --------------------------------------------------------

  declareParameter(p: Parameter, d?: ParameterDescriptor, ignoreOverride = false): Parameter {
    return this.declareParameters([p], d ? [d] : undefined, ignoreOverride)[0]!;
  }

  declareParameters(ps: Parameter[], ds?: ParameterDescriptor[], ignoreOverrides = false): Parameter[] {
    if (ds && ds.length !== ps.length) throw new TypeValidationError("parameters and descriptors length mismatch");
    const toDeclare: [Parameter, ParameterDescriptor][] = [];
    for (let i = 0; i < ps.length; i++) {
      const p0 = ps[i]!;
      if (this.#params.has(p0.name)) throw new ParameterError(`parameter '${p0.name}' has already been declared`);
      const d = ds?.[i] ?? ParameterDescriptor.fromParameter(p0);
      if (d.name !== p0.name) throw new TypeValidationError(`descriptor name '${d.name}' does not match '${p0.name}'`);
      if (d.type === ParameterType.PARAMETER_NOT_SET) d.type = p0.type;
      let p = p0;
      const o = this.#overrides.get(p0.name);
      if (o && !ignoreOverrides) {
        if (!d.dynamicTyping && d.type !== ParameterType.PARAMETER_NOT_SET && o.type !== d.type) {
          // YAML integers are accepted for double parameters
          if (d.type === ParameterType.PARAMETER_DOUBLE && o.type === ParameterType.PARAMETER_INTEGER) {
            p = new Parameter(p0.name, d.type, Number(o.value));
          } else {
            throw new ParameterTypeError(`override for '${p0.name}' has type ${ParameterType[o.type]}, expected ${ParameterType[d.type]}`);
          }
        } else {
          p = o;
        }
      }
      d.validateParameter(p);
      toDeclare.push([p, d]);
    }
    const result = this.#runOnSet(toDeclare.map(([p]) => p));
    if (!result.successful) throw new ParameterError(`declaring parameters rejected: ${result.reason}`);
    for (const [p, d] of toDeclare) {
      this.#params.set(p.name, p);
      this.#descriptors.set(p.name, d);
    }
    this.#publishEvent(toDeclare.map(([p]) => p), [], []);
    return toDeclare.map(([p]) => p);
  }

  undeclareParameter(name: string): void {
    const d = this.#descriptors.get(name);
    if (!d) throw new ParameterNotFoundError(`parameter '${name}' is not declared`);
    if (d.readOnly) throw new ReadOnlyParameterError(`parameter '${name}' is read-only`);
    const p = this.#params.get(name)!;
    this.#params.delete(name);
    this.#descriptors.delete(name);
    this.#publishEvent([], [], [p]);
  }

  hasParameter(name: string): boolean {
    return this.#params.has(name);
  }

  getParameter(name: string): Parameter {
    return this.#params.get(name) ?? new Parameter(name, ParameterType.PARAMETER_NOT_SET);
  }

  getParameters(names: string[] = []): Parameter[] {
    return names.length ? names.map((n) => this.getParameter(n)) : [...this.#params.values()];
  }

  getParameterNames(): string[] {
    return [...this.#params.keys()];
  }

  hasParameterDescriptor(name: string): boolean {
    return this.#descriptors.has(name);
  }

  getParameterDescriptor(name: string): ParameterDescriptor {
    return this.#descriptors.get(name) ?? new ParameterDescriptor(name, ParameterType.PARAMETER_NOT_SET);
  }

  getParameterDescriptors(names: string[] = []): ParameterDescriptor[] {
    return names.length ? names.map((n) => this.getParameterDescriptor(n)) : [...this.#descriptors.values()];
  }

  // ---- set ------------------------------------------------------------------------

  #runOnSet(ps: Parameter[]): SetParametersResult {
    for (const cb of this.#onSet) {
      const r = cb(ps);
      if (!r?.successful) return { successful: false, reason: r?.reason ?? "rejected by callback" };
    }
    return { successful: true, reason: "" };
  }

  #check(p: Parameter): string | null {
    const d = this.#descriptors.get(p.name);
    if (!d) return `parameter '${p.name}' has not been declared`;
    if (d.readOnly) return `parameter '${p.name}' is read-only`;
    if (p.type === ParameterType.PARAMETER_NOT_SET) return null; // undeclare request
    try {
      d.validateParameter(p);
    } catch (e) {
      return (e as Error).message;
    }
    return null;
  }

  #apply(ps: Parameter[]): void {
    const changed: Parameter[] = [];
    const deleted: Parameter[] = [];
    for (const p of ps) {
      if (p.type === ParameterType.PARAMETER_NOT_SET) {
        const old = this.#params.get(p.name);
        this.#params.delete(p.name);
        this.#descriptors.delete(p.name);
        if (old) deleted.push(old);
      } else {
        this.#params.set(p.name, p);
        changed.push(p);
      }
    }
    for (const cb of this.#postSet) cb(ps);
    this.#publishEvent([], changed, deleted);
  }

  #pre(ps: Parameter[]): Parameter[] | null {
    let list = ps;
    for (const cb of this.#preSet) {
      list = cb(list);
      if (!list || list.length === 0) return null;
    }
    return list;
  }

  setParameter(p: Parameter): SetParametersResult {
    return this.setParameters([p])[0]!;
  }

  setParameters(ps: Parameter[]): SetParametersResult[] {
    return ps.map((p) => this.setParametersAtomically([p]));
  }

  setParametersAtomically(ps0: Parameter[]): SetParametersResult {
    const ps = this.#pre(ps0);
    if (!ps) return { successful: false, reason: "parameters rejected by pre-set callback" };
    for (const p of ps) {
      const err = this.#check(p);
      if (err) return { successful: false, reason: err };
    }
    const r = this.#runOnSet(ps);
    if (!r.successful) return r;
    this.#apply(ps);
    return { successful: true, reason: "" };
  }

  addOnSetParametersCallback(cb: OnSet): void { this.#onSet.unshift(cb); }
  removeOnSetParametersCallback(cb: OnSet): void { this.#onSet = this.#onSet.filter((c) => c !== cb); }
  addPreSetParametersCallback(cb: PreSet): void { this.#preSet.push(cb); }
  removePreSetParametersCallback(cb: PreSet): void { this.#preSet = this.#preSet.filter((c) => c !== cb); }
  addPostSetParametersCallback(cb: PostSet): void { this.#postSet.push(cb); }
  removePostSetParametersCallback(cb: PostSet): void { this.#postSet = this.#postSet.filter((c) => c !== cb); }

  #publishEvent(added: Parameter[], changed: Parameter[], deleted: Parameter[]): void {
    if (!this.#events || this.#events.isDestroyed()) return;
    this.#events.publish({
      stamp: this.#node.now().toMsg(),
      node: this.#node.getFullyQualifiedName(),
      new_parameters: added.map((p) => p.toParameterMessage()),
      changed_parameters: changed.map((p) => p.toParameterMessage()),
      deleted_parameters: deleted.map((p) => p.toParameterMessage()),
    });
  }

  // ---- services -------------------------------------------------------------------

  #startServices(): void {
    const n = this.#node;
    const qos = { qos: QoS.profileParameters };
    const svc = (type: string, name: string, h: (req: any) => any) =>
      this.#services.push(n.createService(`rcl_interfaces/srv/${type}`, `~/${name}`, qos, (req) => h(req)));

    svc("GetParameters", "get_parameters", (req) => ({
      values: (req.names as string[]).map((nm) => this.getParameter(nm).toParameterValueMessage()),
    }));
    svc("GetParameterTypes", "get_parameter_types", (req) => ({
      types: (req.names as string[]).map((nm) => this.getParameter(nm).type),
    }));
    svc("DescribeParameters", "describe_parameters", (req) => ({
      descriptors: (req.names as string[]).map((nm) => this.getParameterDescriptor(nm).toMessage()),
    }));
    svc("ListParameters", "list_parameters", (req) => ({ result: this.#list(req.prefixes as string[], Number(req.depth)) }));
    const fromMsgs = (ms: any[]) => ms.map((m) => Parameter.fromParameterMessage(m));
    svc("SetParameters", "set_parameters", (req) => ({ results: this.setParameters(fromMsgs(req.parameters)) }));
    svc("SetParametersAtomically", "set_parameters_atomically", (req) => ({
      result: this.setParametersAtomically(fromMsgs(req.parameters)),
    }));
  }

  /** rclcpp list_parameters semantics ('.' separated, depth 0 = unlimited). */
  #list(prefixes: string[], depth: number): { names: string[]; prefixes: string[] } {
    const SEP = ".";
    const names: string[] = [];
    const found = new Set<string>();
    for (const name of this.#params.keys()) {
      const levels = name.split(SEP).length;
      const withinDepth = depth === 0 || levels <= depth;
      const matches =
        prefixes.length === 0
          ? withinDepth
          : prefixes.some((pre) => name === pre || (name.startsWith(pre + SEP) && (depth === 0 || levels - pre.split(SEP).length <= depth)));
      if (!matches) continue;
      names.push(name);
      const i = name.lastIndexOf(SEP);
      if (i > 0) found.add(name.slice(0, i));
    }
    return { names, prefixes: [...found] };
  }
}
