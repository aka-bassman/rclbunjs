// QoS overrides through read-only parameters (rclnodejs
// lib/qos_overriding_options.js, rclcpp QosOverridingOptions):
//   qos_overrides.<topic>.<publisher|subscription>[_<id>].<policy>
// The parameters are declared with the entity's QoS as default, so values from
// --ros-args -p / params files / NodeOptions override it.
import { Parameter, ParameterDescriptor, ParameterType } from "./parameter.ts";
import { DurabilityPolicy, HistoryPolicy, LivelinessPolicy, QoS, QoSPolicyKind, ReliabilityPolicy } from "./qos.ts";

interface ParameterHost {
  declareParameter(p: Parameter, d?: ParameterDescriptor): Parameter;
  hasParameter(name: string): boolean;
  getParameter(name: string): Parameter;
}

export interface QoSOverridingResult {
  successful: boolean;
  reason?: string;
}

type Enum = Record<string, string | number>;

interface Policy {
  key: string;
  type: ParameterType;
  get(q: QoS): unknown;
  set(q: QoS, v: unknown): void;
}

// enum member <-> parameter string: RMW_QOS_POLICY_RELIABILITY_BEST_EFFORT <-> "best_effort"
function enumPolicy(key: string, prefix: string, e: Enum, prop: "history" | "reliability" | "durability" | "liveliness"): Policy {
  const toStr = (v: unknown) => {
    const name = Object.keys(e).find((k) => e[k] === v && Number.isNaN(Number(k)));
    return name ? name.slice(prefix.length).toLowerCase() : String(v);
  };
  const fromStr = (s: unknown) => {
    const v = e[`${prefix}${String(s).toUpperCase()}`];
    if (typeof v !== "number") throw new Error(`Unknown QoS policy value for ${key}: "${String(s)}"`);
    return v;
  };
  return {
    key,
    type: ParameterType.PARAMETER_STRING,
    get: (q) => toStr(q[prop]),
    set: (q, v) => {
      q[prop] = fromStr(v);
    },
  };
}

const POLICIES: Record<QoSPolicyKind, Policy> = {
  [QoSPolicyKind.HISTORY]: enumPolicy("history", "RMW_QOS_POLICY_HISTORY_", HistoryPolicy as unknown as Enum, "history"),
  [QoSPolicyKind.DEPTH]: {
    key: "depth",
    type: ParameterType.PARAMETER_INTEGER,
    get: (q) => BigInt(q.depth),
    set: (q, v) => {
      q.depth = Number(v);
    },
  },
  [QoSPolicyKind.RELIABILITY]: enumPolicy("reliability", "RMW_QOS_POLICY_RELIABILITY_", ReliabilityPolicy as unknown as Enum, "reliability"),
  [QoSPolicyKind.DURABILITY]: enumPolicy("durability", "RMW_QOS_POLICY_DURABILITY_", DurabilityPolicy as unknown as Enum, "durability"),
  [QoSPolicyKind.LIVELINESS]: enumPolicy("liveliness", "RMW_QOS_POLICY_LIVELINESS_", LivelinessPolicy as unknown as Enum, "liveliness"),
  [QoSPolicyKind.AVOID_ROS_NAMESPACE_CONVENTIONS]: {
    key: "avoid_ros_namespace_conventions",
    type: ParameterType.PARAMETER_BOOL,
    get: (q) => q.avoidRosNameSpaceConventions,
    set: (q, v) => {
      q.avoidRosNameSpaceConventions = Boolean(v);
    },
  },
};

export class QoSOverridingOptions {
  readonly policyKinds: QoSPolicyKind[];
  /** validates the final QoS; an unsuccessful result fails entity creation */
  readonly callback: ((qos: QoS) => QoSOverridingResult | void) | null;
  /** distinguishes several publishers/subscriptions on one topic */
  readonly entityId: string | null;

  constructor(policyKinds: Iterable<QoSPolicyKind>, opts: { callback?: (qos: QoS) => QoSOverridingResult | void; entityId?: string } = {}) {
    this.policyKinds = Array.from(policyKinds);
    this.callback = opts.callback ?? null;
    this.entityId = opts.entityId ?? null;
  }

  /** history, depth and reliability (the rclcpp default set) */
  static withDefaultPolicies(opts: { callback?: (qos: QoS) => QoSOverridingResult | void; entityId?: string } = {}): QoSOverridingOptions {
    return new QoSOverridingOptions([QoSPolicyKind.HISTORY, QoSPolicyKind.DEPTH, QoSPolicyKind.RELIABILITY], opts);
  }
}

/**
 * Declares the override parameters for one entity and returns the QoS with
 * any overridden values applied (`qos` itself is not modified).
 */
export function applyQoSOverrides(
  entityType: "publisher" | "subscription",
  node: ParameterHost,
  resolvedTopic: string,
  qos: QoS,
  options: QoSOverridingOptions,
): QoS {
  const out = qos.clone();
  if (options.policyKinds.length === 0) return out;
  const prefix = `qos_overrides.${resolvedTopic}.${entityType}${options.entityId ? `_${options.entityId}` : ""}`;
  for (const kind of options.policyKinds) {
    const policy = POLICIES[kind];
    if (!policy) continue;
    const name = `${prefix}.${policy.key}`;
    const current = policy.get(out);
    const param = node.hasParameter(name)
      ? node.getParameter(name)
      : node.declareParameter(
          new Parameter(name, policy.type, current),
          new ParameterDescriptor(name, policy.type, `QoS policy ${policy.key} for ${entityType} on ${resolvedTopic}`, true),
        );
    if (param.value !== current) policy.set(out, param.value);
  }
  const result = options.callback?.(out);
  if (result && !result.successful) throw new Error(`QoS override validation failed: ${result.reason ?? "unknown reason"}`);
  return out;
}
