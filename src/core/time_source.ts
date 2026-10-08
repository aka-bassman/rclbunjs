// TimeSource: drives ROSClocks from /clock when the `use_sim_time` parameter is true.
import type { ROSClock } from "./clock.ts";
import type { Node } from "./node.ts";
import { Parameter, ParameterDescriptor, ParameterType } from "./parameter.ts";
import { QoS } from "./qos.ts";
import type { Subscription } from "./subscription.ts";
import { ClockType, Time } from "./time.ts";

const USE_SIM_TIME = "use_sim_time";

export class TimeSource {
  #node: Node | undefined;
  #clocks = new Set<ROSClock>();
  #sub: Subscription | undefined;
  #active = false;
  #last: Time | undefined;

  constructor(node?: Node) {
    this.#node = node;
  }

  /** @internal declares `use_sim_time` on the node and follows its value */
  init(): void {
    const node = this.#node;
    if (!node) return;
    if (!node.hasParameter(USE_SIM_TIME)) {
      node.declareParameter(new Parameter(USE_SIM_TIME, ParameterType.PARAMETER_BOOL, false), new ParameterDescriptor(USE_SIM_TIME, ParameterType.PARAMETER_BOOL));
    }
    node.addOnSetParametersCallback((ps) => {
      const p = ps.find((x) => x.name === USE_SIM_TIME);
      if (p && p.type !== ParameterType.PARAMETER_BOOL) return { successful: false, reason: "use_sim_time must be a bool" };
      return { successful: true };
    });
    node.addPostSetParametersCallback((ps) => {
      const p = ps.find((x) => x.name === USE_SIM_TIME);
      if (p) this.isRosTimeActive = p.value === true;
    });
    this.isRosTimeActive = node.getParameter(USE_SIM_TIME).value === true;
  }

  get isRosTimeActive(): boolean {
    return this.#active;
  }

  set isRosTimeActive(enabled: boolean) {
    if (enabled === this.#active) return;
    this.#active = enabled;
    for (const c of this.#clocks) this.#applyTo(c);
    if (enabled) this.#subscribe();
    else this.#unsubscribe();
  }

  attachNode(node: Node): void {
    this.#unsubscribe();
    this.#node = node;
    if (this.#active) this.#subscribe();
  }

  detachNode(): void {
    this.#unsubscribe();
    this.#node = undefined;
  }

  attachClock(clock: ROSClock): void {
    if (clock.clockType !== ClockType.ROS_TIME) throw new TypeError("only ROS_TIME clocks can be attached");
    this.#clocks.add(clock);
    this.#applyTo(clock);
  }

  #applyTo(c: ROSClock): void {
    if (this.#active) c.rosTimeOverride = this.#last ?? new Time(0n, 0n, ClockType.ROS_TIME);
    else c.isRosTimeActive = false;
  }

  #subscribe(): void {
    const node = this.#node;
    if (!node || this.#sub || node.isDestroyed()) return;
    const qos = new QoS(QoS.HistoryPolicy.RMW_QOS_POLICY_HISTORY_KEEP_LAST, 1, QoS.ReliabilityPolicy.RMW_QOS_POLICY_RELIABILITY_BEST_EFFORT);
    this.#sub = node.createSubscription("rosgraph_msgs/msg/Clock", "/clock", { qos }, (msg: any) => {
      this.#last = Time.fromMsg(msg.clock, ClockType.ROS_TIME);
      if (!this.#active) return;
      for (const c of this.#clocks) c.rosTimeOverride = this.#last;
    });
  }

  #unsubscribe(): void {
    if (this.#sub && this.#node && !this.#node.isDestroyed()) this.#node.destroySubscription(this.#sub);
    this.#sub = undefined;
  }
}
