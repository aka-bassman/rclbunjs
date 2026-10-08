// Interface registry: turns a ROS type name into a codec (CDR <-> plain JS
// object) backed by @foxglove/rosmsg2-serialization, plus lazy typesupport.
import type { MessageDefinition } from "@foxglove/message-definition";
import { parse as parseMsg } from "@foxglove/rosmsg";
import { parseRos2idl } from "@foxglove/ros2idl-parser";
import type { Pointer } from "bun:ffi";
import { buildCodec, type DecodeOptions } from "./cdr.ts";
import { readInterface, type InterfaceKind } from "./discovery.ts";
import { actionTypeSupport, messageTypeSupport, serviceTypeSupport } from "./typesupport.ts";
import { InterfaceNotFoundError, TypeValidationError } from "../core/errors.ts";

export type TypeName = string | { package: string; type: string; name: string };

export interface ParsedName {
  pkg: string;
  kind: InterfaceKind;
  name: string;
}

const PRIMITIVES = new Set([
  "bool", "byte", "char", "float32", "float64", "int8", "uint8", "int16", "uint16",
  "int32", "uint32", "int64", "uint64", "string", "wstring", "octet",
]);

/** Accepts 'pkg/msg/Name', 'pkg/Name' (msg), or {package, type, name}. */
export function parseTypeName(t: TypeName, defaultKind: InterfaceKind = "msg"): ParsedName {
  if (typeof t === "object" && t !== null) {
    return { pkg: t.package, kind: t.type as InterfaceKind, name: t.name };
  }
  if (typeof t === "function" && typeof (t as { type?: () => unknown }).type === "function") {
    const info = (t as unknown as { type(): { pkgName: string; subFolder: string; interfaceName: string } }).type();
    return { pkg: info.pkgName, kind: info.subFolder as InterfaceKind, name: info.interfaceName };
  }
  const parts = String(t).split("/");
  if (parts.length === 3 && (parts[1] === "msg" || parts[1] === "srv" || parts[1] === "action")) {
    return { pkg: parts[0]!, kind: parts[1], name: parts[2]! };
  }
  if (parts.length === 2) return { pkg: parts[0]!, kind: defaultKind, name: parts[1]! };
  throw new TypeValidationError(`invalid interface type name: ${String(t)}`);
}

export const typeKey = (p: ParsedName) => `${p.pkg}/${p.kind}/${p.name}`;

function canonicalFieldType(raw: string, ownPkg: string): string {
  // @foxglove/rosmsg turns builtin_interfaces/Time|Duration into 'time'|'duration'
  if (raw === "time") return "builtin_interfaces/msg/Time";
  if (raw === "duration") return "builtin_interfaces/msg/Duration";
  const parts = raw.split("/");
  if (parts.length === 3) return raw;
  if (parts.length === 2) return `${parts[0]}/msg/${parts[1]}`;
  return `${ownPkg}/msg/${raw}`;
}

/** Parses one .msg-style section into a root definition with canonical field types. */
function parseSection(text: string, pkg: string, fullName: string): MessageDefinition {
  const [root] = parseMsg(text, { ros2: true, skipTypeFixup: true });
  const def: MessageDefinition = { name: fullName, definitions: root?.definitions ?? [] };
  for (const f of def.definitions) {
    if (!f.isConstant && !PRIMITIVES.has(f.type)) {
      f.type = canonicalFieldType(f.type, pkg);
      f.isComplex = true;
    }
  }
  return def;
}

/** Splits .srv/.action text on '---' separator lines. */
function splitSections(text: string): string[] {
  return text.split(/^\s*---\s*$/m);
}

export interface MessageType {
  readonly name: string; // canonical 'pkg/kind/Name' (kind may be srv/action for nested messages)
  readonly pkg: string;
  readonly kind: InterfaceKind;
  readonly shortName: string; // e.g. 'String', 'AddTwoInts_Request'
  readonly definitions: MessageDefinition[];
  readonly constants: Record<string, unknown>;
  encode(msg: unknown): Uint8Array;
  decode(bytes: Uint8Array, options?: DecodeOptions): any;
  /** A fresh object filled with default values. */
  create(): any;
  typeSupport(): Pointer;
}

export interface ServiceType {
  readonly name: string;
  readonly pkg: string;
  readonly shortName: string;
  readonly request: MessageType;
  readonly response: MessageType;
  typeSupport(): Pointer;
}

export interface ActionType {
  readonly name: string;
  readonly pkg: string;
  readonly shortName: string;
  readonly goal: MessageType;
  readonly result: MessageType;
  readonly feedback: MessageType;
  readonly sendGoalRequest: MessageType;
  readonly sendGoalResponse: MessageType;
  readonly getResultRequest: MessageType;
  readonly getResultResponse: MessageType;
  readonly feedbackMessage: MessageType;
  readonly sendGoal: ServiceType;
  readonly getResult: ServiceType;
  typeSupport(): Pointer;
}

const definitionCache = new Map<string, MessageDefinition>();
const messageCache = new Map<string, MessageType>();
const serviceCache = new Map<string, ServiceType>();
const actionCache = new Map<string, ActionType>();

function loadIdl(pkg: string, kind: InterfaceKind, name: string, text: string): void {
  for (const d of parseRos2idl(text)) {
    if (!d.name) continue;
    const full = d.name.split("/").length === 2 ? `${d.name.split("/")[0]}/msg/${d.name.split("/")[1]}` : d.name;
    for (const f of d.definitions) {
      if (!f.isConstant && !PRIMITIVES.has(f.type)) {
        f.type = canonicalFieldType(f.type, pkg);
        f.isComplex = true;
      }
    }
    definitionCache.set(full, { name: full, definitions: d.definitions });
  }
  void kind;
  void name;
}

/** Root definition of a message (loads the file that declares it on demand). */
function definitionOf(full: string): MessageDefinition {
  const cached = definitionCache.get(full);
  if (cached) return cached;
  const [pkg, kind, short] = full.split("/") as [string, InterfaceKind, string];
  if (kind === "msg") {
    const src = readInterface(pkg, "msg", short);
    if (!src) throw new InterfaceNotFoundError(`message definition not found: ${full}`);
    if (src.format === "idl") loadIdl(pkg, kind, short, src.text);
    else definitionCache.set(full, parseSection(src.text, pkg, full));
  } else if (kind === "srv") {
    const base = short.replace(/_(Request|Response|Event)$/, "");
    loadService(pkg, base);
  } else {
    const base = short.replace(/_(Goal|Result|Feedback|SendGoal_Request|SendGoal_Response|GetResult_Request|GetResult_Response|FeedbackMessage)$/, "");
    loadAction(pkg, base);
  }
  const def = definitionCache.get(full);
  if (!def) throw new InterfaceNotFoundError(`message definition not found: ${full}`);
  return def;
}

function loadService(pkg: string, name: string): void {
  if (definitionCache.has(`${pkg}/srv/${name}_Request`)) return;
  const src = readInterface(pkg, "srv", name);
  if (!src) throw new InterfaceNotFoundError(`service definition not found: ${pkg}/srv/${name}`);
  if (src.format === "idl") {
    loadIdl(pkg, "srv", name, src.text);
    return addServiceEvent(pkg, name);
  }
  const [req = "", resp = ""] = splitSections(src.text);
  definitionCache.set(`${pkg}/srv/${name}_Request`, parseSection(req, pkg, `${pkg}/srv/${name}_Request`));
  definitionCache.set(`${pkg}/srv/${name}_Response`, parseSection(resp, pkg, `${pkg}/srv/${name}_Response`));
  addServiceEvent(pkg, name);
}

// <Service>_Event, published on <service>/_service_event by service
// introspection (rosidl generates it for every service since Iron).
function addServiceEvent(pkg: string, name: string): void {
  const base = `${pkg}/srv/${name}`;
  if (definitionCache.has(`${base}_Event`)) return;
  definitionCache.set(`${base}_Event`, {
    name: `${base}_Event`,
    definitions: [
      { type: "service_msgs/msg/ServiceEventInfo", name: "info", isComplex: true, isArray: false },
      { type: `${base}_Request`, name: "request", isComplex: true, isArray: true, arrayUpperBound: 1 },
      { type: `${base}_Response`, name: "response", isComplex: true, isArray: true, arrayUpperBound: 1 },
    ],
  });
}

function loadAction(pkg: string, name: string): void {
  const base = `${pkg}/action/${name}`;
  if (definitionCache.has(`${base}_Goal`)) return;
  const src = readInterface(pkg, "action", name);
  if (!src) throw new InterfaceNotFoundError(`action definition not found: ${base}`);
  if (src.format === "idl") loadIdl(pkg, "action", name, src.text);
  else {
    const [goal = "", result = "", feedback = ""] = splitSections(src.text);
    definitionCache.set(`${base}_Goal`, parseSection(goal, pkg, `${base}_Goal`));
    definitionCache.set(`${base}_Result`, parseSection(result, pkg, `${base}_Result`));
    definitionCache.set(`${base}_Feedback`, parseSection(feedback, pkg, `${base}_Feedback`));
  }
  // Derived messages (see rosidl_generator: action -> services/messages).
  const uuid = { type: "unique_identifier_msgs/msg/UUID", name: "goal_id", isComplex: true, isArray: false };
  const stamp = { type: "builtin_interfaces/msg/Time", name: "stamp", isComplex: true, isArray: false };
  const derived: Record<string, MessageDefinition["definitions"]> = {
    SendGoal_Request: [uuid, { type: `${base}_Goal`, name: "goal", isComplex: true, isArray: false }],
    SendGoal_Response: [{ type: "bool", name: "accepted", isArray: false }, stamp],
    GetResult_Request: [uuid],
    GetResult_Response: [
      { type: "int8", name: "status", isArray: false },
      { type: `${base}_Result`, name: "result", isComplex: true, isArray: false },
    ],
    FeedbackMessage: [uuid, { type: `${base}_Feedback`, name: "feedback", isComplex: true, isArray: false }],
  };
  for (const [suffix, defs] of Object.entries(derived)) {
    const full = `${base}_${suffix}`;
    if (!definitionCache.has(full)) definitionCache.set(full, { name: full, definitions: defs });
  }
}

/** Root definition followed by every transitively referenced definition. */
function closure(full: string): MessageDefinition[] {
  const out: MessageDefinition[] = [];
  const seen = new Set<string>();
  const visit = (n: string) => {
    if (seen.has(n)) return;
    seen.add(n);
    const d = definitionOf(n);
    out.push(d);
    for (const f of d.definitions) if (f.isComplex && !f.isConstant) visit(f.type);
  };
  visit(full);
  return out;
}

function makeMessageType(full: string, typeSupport: () => Pointer): MessageType {
  const defs = closure(full);
  const [pkg, kind, shortName] = full.split("/") as [string, InterfaceKind, string];
  const codec = buildCodec(defs);
  const constants: Record<string, unknown> = {};
  for (const f of defs[0]!.definitions) if (f.isConstant) constants[f.name] = f.value;
  let ts: Pointer | undefined;
  return {
    name: full,
    pkg,
    kind,
    shortName,
    definitions: defs,
    constants,
    encode: codec.encode,
    decode: codec.decode,
    create: codec.create,
    typeSupport: () => (ts ??= typeSupport()),
  };
}

/** Message type for 'pkg/msg/Name' (also accepts srv/action nested messages like 'pkg/srv/X_Request'). */
export function getMessageType(t: TypeName): MessageType {
  const p = parseTypeName(t, "msg");
  const full = typeKey(p);
  let mt = messageCache.get(full);
  if (!mt) {
    mt = makeMessageType(full, () => messageTypeSupport(p.pkg, p.kind, p.name));
    messageCache.set(full, mt);
  }
  return mt;
}

export function getServiceType(t: TypeName): ServiceType {
  const p = parseTypeName(t, "srv");
  if (p.kind !== "srv") throw new TypeValidationError(`not a service type: ${typeKey(p)}`);
  const full = typeKey(p);
  let st = serviceCache.get(full);
  if (!st) {
    loadService(p.pkg, p.name);
    let ts: Pointer | undefined;
    st = {
      name: full,
      pkg: p.pkg,
      shortName: p.name,
      request: getMessageType(`${full}_Request`),
      response: getMessageType(`${full}_Response`),
      typeSupport: () => (ts ??= serviceTypeSupport(p.pkg, "srv", p.name)),
    };
    serviceCache.set(full, st);
  }
  return st;
}

export function getActionType(t: TypeName): ActionType {
  const p = parseTypeName(t, "action");
  if (p.kind !== "action") throw new TypeValidationError(`not an action type: ${typeKey(p)}`);
  const full = typeKey(p);
  let at = actionCache.get(full);
  if (!at) {
    loadAction(p.pkg, p.name);
    const m = (s: string) => getMessageType(`${full}_${s}`);
    const svc = (s: string): ServiceType => {
      let ts: Pointer | undefined;
      return {
        name: `${full}_${s}`,
        pkg: p.pkg,
        shortName: `${p.name}_${s}`,
        request: m(`${s}_Request`),
        response: m(`${s}_Response`),
        typeSupport: () => (ts ??= serviceTypeSupport(p.pkg, "action", `${p.name}_${s}`)),
      };
    };
    let ts: Pointer | undefined;
    at = {
      name: full,
      pkg: p.pkg,
      shortName: p.name,
      goal: m("Goal"),
      result: m("Result"),
      feedback: m("Feedback"),
      sendGoalRequest: m("SendGoal_Request"),
      sendGoalResponse: m("SendGoal_Response"),
      getResultRequest: m("GetResult_Request"),
      getResultResponse: m("GetResult_Response"),
      feedbackMessage: m("FeedbackMessage"),
      sendGoal: svc("SendGoal"),
      getResult: svc("GetResult"),
      typeSupport: () => (ts ??= actionTypeSupport(p.pkg, p.name)),
    };
    actionCache.set(full, at);
  }
  return at;
}

/** Kind of interface a type name refers to. */
export function interfaceKind(t: TypeName): InterfaceKind {
  return parseTypeName(t).kind;
}
