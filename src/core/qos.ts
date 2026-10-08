// QoS profiles, mirroring rclnodejs (lib/qos.js) and rmw's preset profiles.
import { TypeValidationError } from "./errors.ts";

export enum HistoryPolicy {
  RMW_QOS_POLICY_HISTORY_SYSTEM_DEFAULT = 0,
  RMW_QOS_POLICY_HISTORY_KEEP_LAST = 1,
  RMW_QOS_POLICY_HISTORY_KEEP_ALL = 2,
}

export enum ReliabilityPolicy {
  RMW_QOS_POLICY_RELIABILITY_SYSTEM_DEFAULT = 0,
  RMW_QOS_POLICY_RELIABILITY_RELIABLE = 1,
  RMW_QOS_POLICY_RELIABILITY_BEST_EFFORT = 2,
}

export enum DurabilityPolicy {
  RMW_QOS_POLICY_DURABILITY_SYSTEM_DEFAULT = 0,
  RMW_QOS_POLICY_DURABILITY_TRANSIENT_LOCAL = 1,
  RMW_QOS_POLICY_DURABILITY_VOLATILE = 2,
}

export enum LivelinessPolicy {
  RMW_QOS_POLICY_LIVELINESS_SYSTEM_DEFAULT = 0,
  RMW_QOS_POLICY_LIVELINESS_AUTOMATIC = 1,
  RMW_QOS_POLICY_LIVELINESS_MANUAL_BY_TOPIC = 3,
  RMW_QOS_POLICY_LIVELINESS_UNKNOWN = 4,
  RMW_QOS_POLICY_LIVELINESS_BEST_AVAILABLE = 5,
}

export enum QoSPolicyKind {
  HISTORY = 1,
  DEPTH = 2,
  RELIABILITY = 3,
  DURABILITY = 4,
  LIVELINESS = 5,
  AVOID_ROS_NAMESPACE_CONVENTIONS = 6,
}

/** Durations are bigint nanoseconds; 0n = rmw default, -1n = infinite. */
export class QoS {
  static HistoryPolicy = HistoryPolicy;
  static ReliabilityPolicy = ReliabilityPolicy;
  static DurabilityPolicy = DurabilityPolicy;
  static LivelinessPolicy = LivelinessPolicy;

  static readonly profileDefault = "qos_profile_default";
  static readonly profileSystemDefault = "qos_profile_system_default";
  static readonly profileSensorData = "qos_profile_sensor_data";
  static readonly profileServicesDefault = "qos_profile_services_default";
  static readonly profileParameters = "qos_profile_parameters";
  static readonly profileParameterEvents = "qos_profile_parameter_events";
  static readonly profileActionStatusDefault = "qos_profile_action_status_default";
  static readonly profileRosoutDefault = "qos_profile_rosout_default";

  #history: number;
  #depth: number;
  #reliability: number;
  #durability: number;
  #liveliness: number;
  #avoidRosNameSpaceConventions: boolean;
  deadline = 0n;
  lifespan = 0n;
  livelinessLeaseDuration = 0n;

  constructor(
    history: number = HistoryPolicy.RMW_QOS_POLICY_HISTORY_SYSTEM_DEFAULT,
    depth = 0,
    reliability: number = ReliabilityPolicy.RMW_QOS_POLICY_RELIABILITY_SYSTEM_DEFAULT,
    durability: number = DurabilityPolicy.RMW_QOS_POLICY_DURABILITY_SYSTEM_DEFAULT,
    liveliness: number = LivelinessPolicy.RMW_QOS_POLICY_LIVELINESS_SYSTEM_DEFAULT,
    avoidRosNameSpaceConventions = false,
  ) {
    this.#history = history;
    this.#depth = depth;
    this.#reliability = reliability;
    this.#durability = durability;
    this.#liveliness = liveliness;
    this.#avoidRosNameSpaceConventions = avoidRosNameSpaceConventions;
  }

  static #num(v: unknown, what: string): number {
    if (typeof v !== "number") throw new TypeValidationError(`QoS ${what} must be a number`);
    return v;
  }

  get history() { return this.#history; }
  set history(v: number) { this.#history = QoS.#num(v, "history"); }
  get depth() { return this.#depth; }
  set depth(v: number) { this.#depth = QoS.#num(v, "depth"); }
  get reliability() { return this.#reliability; }
  set reliability(v: number) { this.#reliability = QoS.#num(v, "reliability"); }
  get durability() { return this.#durability; }
  set durability(v: number) { this.#durability = QoS.#num(v, "durability"); }
  get liveliness() { return this.#liveliness; }
  set liveliness(v: number) { this.#liveliness = QoS.#num(v, "liveliness"); }
  get avoidRosNameSpaceConventions() { return this.#avoidRosNameSpaceConventions; }
  set avoidRosNameSpaceConventions(v: boolean) { this.#avoidRosNameSpaceConventions = Boolean(v); }

  clone(): QoS {
    const q = new QoS(this.#history, this.#depth, this.#reliability, this.#durability, this.#liveliness, this.#avoidRosNameSpaceConventions);
    q.deadline = this.deadline;
    q.lifespan = this.lifespan;
    q.livelinessLeaseDuration = this.livelinessLeaseDuration;
    return q;
  }

  /** Packs into the shim's int64[9] layout. */
  toNative(): BigInt64Array {
    return BigInt64Array.from([
      BigInt(this.#history),
      BigInt(this.#depth),
      BigInt(this.#reliability),
      BigInt(this.#durability),
      this.deadline,
      this.lifespan,
      BigInt(this.#liveliness),
      this.livelinessLeaseDuration,
      this.#avoidRosNameSpaceConventions ? 1n : 0n,
    ]);
  }

  /** Resolves a QoS instance or profile name to a QoS instance. */
  static from(q: QoS | string | undefined, fallback: string = QoS.profileDefault): QoS {
    if (q instanceof QoS) return q;
    const name = q ?? fallback;
    const make = PROFILES[name];
    if (!make) throw new TypeValidationError(`unknown QoS profile '${name}'`);
    return make();
  }

  /** Builds a QoS from the shim's JSON representation. */
  static fromJSON(j: {
    history: number; depth: number; reliability: number; durability: number; deadline: number;
    lifespan: number; liveliness: number; livelinessLeaseDuration: number; avoidRosNamespaceConventions: boolean;
  }): QoS {
    const q = new QoS(j.history, j.depth, j.reliability, j.durability, j.liveliness, j.avoidRosNamespaceConventions);
    q.deadline = BigInt(j.deadline);
    q.lifespan = BigInt(j.lifespan);
    q.livelinessLeaseDuration = BigInt(j.livelinessLeaseDuration);
    return q;
  }
}

const KEEP_LAST = HistoryPolicy.RMW_QOS_POLICY_HISTORY_KEEP_LAST;
const RELIABLE = ReliabilityPolicy.RMW_QOS_POLICY_RELIABILITY_RELIABLE;
const BEST_EFFORT = ReliabilityPolicy.RMW_QOS_POLICY_RELIABILITY_BEST_EFFORT;
const VOLATILE = DurabilityPolicy.RMW_QOS_POLICY_DURABILITY_VOLATILE;
const TRANSIENT_LOCAL = DurabilityPolicy.RMW_QOS_POLICY_DURABILITY_TRANSIENT_LOCAL;

const PROFILES: Record<string, () => QoS> = {
  [QoS.profileDefault]: () => new QoS(KEEP_LAST, 10, RELIABLE, VOLATILE),
  [QoS.profileSystemDefault]: () => new QoS(),
  [QoS.profileSensorData]: () => new QoS(KEEP_LAST, 5, BEST_EFFORT, VOLATILE),
  [QoS.profileServicesDefault]: () => new QoS(KEEP_LAST, 10, RELIABLE, VOLATILE),
  [QoS.profileParameters]: () => new QoS(KEEP_LAST, 1000, RELIABLE, VOLATILE),
  [QoS.profileParameterEvents]: () => new QoS(KEEP_LAST, 1000, RELIABLE, VOLATILE),
  [QoS.profileActionStatusDefault]: () => new QoS(KEEP_LAST, 1, RELIABLE, TRANSIENT_LOCAL),
  [QoS.profileRosoutDefault]: () => {
    const q = new QoS(KEEP_LAST, 1000, RELIABLE, TRANSIENT_LOCAL);
    q.lifespan = 10_000_000_000n;
    return q;
  },
};
