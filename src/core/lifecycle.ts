// Managed (lifecycle) nodes: the rcl_lifecycle default state machine, its
// services (~/change_state, ~/get_state, ~/get_available_states,
// ~/get_available_transitions, ~/get_transition_graph) and ~/transition_event,
// implemented in TypeScript. API follows rclnodejs lib/lifecycle.js.
import type { Context } from "./context.ts";
import type { EntityOptions } from "./entity.ts";
import { OperationError } from "./errors.ts";
import { Node, type NodeOptions, type NodeOptionsInit } from "./node.ts";
import { Publisher } from "./publisher.ts";
import type { KnownOr, MessageOf, MessageTypeName } from "../types.ts";
import { getMessageType, type TypeName, type MessageType } from "../interfaces/registry.ts";

export class State {
  constructor(readonly id: number, readonly label: string) {}
  asMessage() {
    return { id: this.id, label: this.label };
  }
}

export class Transition extends State {}

export class TransitionDescription {
  constructor(readonly transition: Transition, readonly startState: State, readonly goalState: State) {}
  asMessage() {
    return { transition: this.transition.asMessage(), start_state: this.startState.asMessage(), goal_state: this.goalState.asMessage() };
  }
}

export enum CallbackReturnCode {
  SUCCESS = 97,
  FAILURE = 98,
  ERROR = 99,
}

export class CallbackReturnValue {
  value: CallbackReturnCode;
  errorMsg: string | undefined;
  constructor(value: CallbackReturnCode = CallbackReturnCode.SUCCESS) {
    this.value = value;
  }
  isSuccess() { return this.value === CallbackReturnCode.SUCCESS; }
  isFailure() { return this.value === CallbackReturnCode.FAILURE; }
  isError() { return this.value === CallbackReturnCode.ERROR; }
  hasErrorMsg() { return this.errorMsg !== undefined; }
}

export type TransitionCallback = (previousState: State) => CallbackReturnCode | CallbackReturnValue | void;

// lifecycle_msgs/msg/State
export const S = {
  UNKNOWN: new State(0, "unknown"),
  UNCONFIGURED: new State(1, "unconfigured"),
  INACTIVE: new State(2, "inactive"),
  ACTIVE: new State(3, "active"),
  FINALIZED: new State(4, "finalized"),
  CONFIGURING: new State(10, "configuring"),
  CLEANINGUP: new State(11, "cleaningup"),
  SHUTTINGDOWN: new State(12, "shuttingdown"),
  ACTIVATING: new State(13, "activating"),
  DEACTIVATING: new State(14, "deactivating"),
  ERRORPROCESSING: new State(15, "errorprocessing"),
} as const;

const T = (id: number, label: string) => new Transition(id, label);
const D = (t: Transition, a: State, b: State) => new TransitionDescription(t, a, b);

type CallbackName = "configure" | "cleanup" | "activate" | "deactivate" | "shutdown" | "error";

interface Step {
  /** public transition triggered by the user */
  trigger: TransitionDescription;
  callback: CallbackName;
  /** result transitions keyed by callback outcome */
  success: TransitionDescription;
  failure: TransitionDescription;
  error: TransitionDescription;
}

const step = (id: number, label: string, from: State, mid: State, cb: CallbackName, base: number, ok: State, fail: State): Step => ({
  trigger: D(T(id, label), from, mid),
  callback: cb,
  success: D(T(base, "transition_success"), mid, ok),
  failure: D(T(base + 1, "transition_failure"), mid, fail),
  error: D(T(base + 2, "transition_error"), mid, S.ERRORPROCESSING),
});

// rcl_lifecycle default state machine
const STEPS: Step[] = [
  step(1, "configure", S.UNCONFIGURED, S.CONFIGURING, "configure", 10, S.INACTIVE, S.UNCONFIGURED),
  step(2, "cleanup", S.INACTIVE, S.CLEANINGUP, "cleanup", 20, S.UNCONFIGURED, S.INACTIVE),
  step(3, "activate", S.INACTIVE, S.ACTIVATING, "activate", 30, S.ACTIVE, S.INACTIVE),
  step(4, "deactivate", S.ACTIVE, S.DEACTIVATING, "deactivate", 40, S.INACTIVE, S.ACTIVE),
  step(5, "shutdown", S.UNCONFIGURED, S.SHUTTINGDOWN, "shutdown", 50, S.FINALIZED, S.FINALIZED),
  step(6, "shutdown", S.INACTIVE, S.SHUTTINGDOWN, "shutdown", 50, S.FINALIZED, S.FINALIZED),
  step(7, "shutdown", S.ACTIVE, S.SHUTTINGDOWN, "shutdown", 50, S.FINALIZED, S.FINALIZED),
];
const ERROR_STEP = {
  success: D(T(60, "transition_success"), S.ERRORPROCESSING, S.UNCONFIGURED),
  failure: D(T(61, "transition_failure"), S.ERRORPROCESSING, S.FINALIZED),
  error: D(T(62, "transition_error"), S.ERRORPROCESSING, S.FINALIZED),
};

const PRIMARY = [S.UNKNOWN, S.UNCONFIGURED, S.INACTIVE, S.ACTIVE, S.FINALIZED];
const ALL_STATES = Object.values(S);

/** Publisher that only publishes while activated. */
export class LifecyclePublisher<T = any> extends Publisher<T> {
  #active = false;

  activate(): void { this.#active = true; }
  deactivate(): void { this.#active = false; }
  isActivated(): boolean { return this.#active; }
  onActivate(): void { this.activate(); }
  onDeactivate(): void { this.deactivate(); }

  override publish(msg: Parameters<Publisher<T>["publish"]>[0], options?: { validate?: boolean }): void {
    if (!this.#active) return;
    super.publish(msg, options);
  }
}

export class LifecycleNode extends Node {
  #state: State = S.UNCONFIGURED;
  #callbacks = new Map<CallbackName, TransitionCallback>();
  #managed = new Set<LifecyclePublisher>();
  #events: Publisher | undefined;

  constructor(
    name: string,
    namespace = "",
    context?: Context,
    options?: NodeOptions | NodeOptionsInit,
    enableCommunicationInterface = true,
  ) {
    super(name, namespace, context, options);
    if (enableCommunicationInterface) this.#startInterface();
  }

  get currentState(): State { return this.#state; }
  get availableStates(): State[] { return [...ALL_STATES]; }
  get availableTransitions(): TransitionDescription[] {
    return STEPS.filter((s) => s.trigger.startState.id === this.#state.id).map((s) => s.trigger);
  }
  get transitions(): TransitionDescription[] {
    return [...STEPS.flatMap((s) => [s.trigger, s.success, s.failure, s.error]), ERROR_STEP.success, ERROR_STEP.failure, ERROR_STEP.error];
  }
  get isInitialized(): boolean { return true; }

  registerOnConfigure(cb: TransitionCallback) { this.#callbacks.set("configure", cb); }
  registerOnCleanup(cb: TransitionCallback) { this.#callbacks.set("cleanup", cb); }
  registerOnActivate(cb: TransitionCallback) { this.#callbacks.set("activate", cb); }
  registerOnDeactivate(cb: TransitionCallback) { this.#callbacks.set("deactivate", cb); }
  registerOnShutdown(cb: TransitionCallback) { this.#callbacks.set("shutdown", cb); }
  registerOnError(cb: TransitionCallback) { this.#callbacks.set("error", cb); }

  configure(): State { return this.#trigger(1); }
  cleanup(): State { return this.#trigger(2); }
  activate(): State { return this.#trigger(3); }
  deactivate(): State { return this.#trigger(4); }
  shutdown(): State { return this.#triggerByLabel("shutdown"); }

  /** Triggers a transition by id or label; returns the resulting state. */
  triggerTransition(idOrLabel: number | string): State {
    return typeof idOrLabel === "number" ? this.#trigger(idOrLabel) : this.#triggerByLabel(idOrLabel);
  }

  createLifecyclePublisher<K extends KnownOr<MessageTypeName>, T = MessageOf<K>>(
    typeClass: K | MessageType | Exclude<TypeName, string>,
    topic: string,
    options?: EntityOptions,
  ): LifecyclePublisher<T> {
    const mt = typeof typeClass === "object" && "encode" in typeClass ? typeClass : getMessageType(typeClass as TypeName);
    const opts = { ...Node.getDefaultOptions(), ...(options ?? {}) };
    const lp = this._adoptPublisher((h, logger) => new LifecyclePublisher<T>(h, logger, mt, topic, opts));
    if (this.#state.id === S.ACTIVE.id) lp.activate();
    this.#managed.add(lp as LifecyclePublisher);
    return lp;
  }

  #triggerByLabel(label: string): State {
    const s = STEPS.find((x) => x.trigger.transition.label === label && x.trigger.startState.id === this.#state.id);
    if (!s) throw new OperationError(`transition '${label}' is not available in state '${this.#state.label}'`);
    return this.#run(s);
  }

  #trigger(id: number): State {
    const s = STEPS.find((x) => x.trigger.transition.id === id && x.trigger.startState.id === this.#state.id);
    if (!s) throw new OperationError(`transition ${id} is not available in state '${this.#state.label}'`);
    return this.#run(s);
  }

  #invoke(name: CallbackName, prev: State): CallbackReturnCode {
    const cb = this.#callbacks.get(name);
    if (!cb) return name === "error" ? CallbackReturnCode.FAILURE : CallbackReturnCode.SUCCESS;
    try {
      const r = cb(prev);
      if (r instanceof CallbackReturnValue) return r.value;
      return r ?? CallbackReturnCode.SUCCESS;
    } catch (e) {
      this.getLogger().error(`lifecycle ${name} callback threw: ${String(e)}`);
      return CallbackReturnCode.ERROR;
    }
  }

  #move(d: TransitionDescription): void {
    this.#state = d.goalState;
    this.#events?.publish({
      timestamp: this.now().nanoseconds,
      transition: d.transition.asMessage(),
      start_state: d.startState.asMessage(),
      goal_state: d.goalState.asMessage(),
    });
  }

  #run(s: Step): State {
    const prev = this.#state;
    this.#move(s.trigger);
    const rc = this.#invoke(s.callback, prev);
    const result = rc === CallbackReturnCode.SUCCESS ? s.success : rc === CallbackReturnCode.FAILURE ? s.failure : s.error;
    this.#move(result);
    if (this.#state.id === S.ERRORPROCESSING.id) {
      const erc = this.#invoke("error", prev);
      this.#move(erc === CallbackReturnCode.SUCCESS ? ERROR_STEP.success : erc === CallbackReturnCode.FAILURE ? ERROR_STEP.failure : ERROR_STEP.error);
    }
    const active = this.#state.id === S.ACTIVE.id;
    for (const p of this.#managed) active ? p.activate() : p.deactivate();
    return this.#state;
  }

  #startInterface(): void {
    this.#events = this.createPublisher("lifecycle_msgs/msg/TransitionEvent", "~/transition_event");
    this.createService("lifecycle_msgs/srv/GetState", "~/get_state", () => ({ current_state: this.#state.asMessage() }));
    this.createService("lifecycle_msgs/srv/GetAvailableStates", "~/get_available_states", () => ({
      available_states: ALL_STATES.map((st) => st.asMessage()),
    }));
    this.createService("lifecycle_msgs/srv/GetAvailableTransitions", "~/get_available_transitions", () => ({
      available_transitions: PRIMARY.some((p) => p.id === this.#state.id) ? this.availableTransitions.map((d) => d.asMessage()) : [],
    }));
    this.createService("lifecycle_msgs/srv/GetAvailableTransitions", "~/get_transition_graph", () => ({
      available_transitions: this.transitions.map((d) => d.asMessage()),
    }));
    this.createService("lifecycle_msgs/srv/ChangeState", "~/change_state", (req: any) => {
      const { id, label } = req.transition as { id: number; label: string };
      try {
        const before = this.#state.id;
        id === 0 && label ? this.#triggerByLabel(label) : this.#trigger(id);
        // success means the intended (success) goal state was reached
        const step = STEPS.find((x) => x.trigger.startState.id === before && (id === 0 ? x.trigger.transition.label === label : x.trigger.transition.id === id));
        return { success: step ? this.#state.id === step.success.goalState.id : false };
      } catch (e) {
        this.getLogger().warn(String((e as Error).message));
        return { success: false };
      }
    });
  }
}
