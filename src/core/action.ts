// ROS 2 actions implemented in TypeScript on top of plain services/topics.
// Wire-compatible with rcl_action (rclcpp/rclpy): <action>/_action/{send_goal,
// cancel_goal,get_result} services and <action>/_action/{feedback,status} topics.
// Behavior follows rclnodejs lib/action/* and rclpy's ActionServer/ActionClient.
import { randomBytes } from "node:crypto";
import { getActionType, getMessageType, getServiceType, type ActionType, type TypeName } from "../interfaces/registry.ts";
import type { Client } from "./client.ts";
import { ActionServerNotFoundError } from "./errors.ts";
import type { Node } from "./node.ts";
import type { Publisher } from "./publisher.ts";
import { QoS } from "./qos.ts";
import type { Service, ServiceResponse } from "./service.ts";
import type { Subscription } from "./subscription.ts";
import { Logging } from "./logging.ts";
import type { ActionTypeName, FeedbackOf, GoalOf, KnownOr, MessageInput, ResultOf } from "../types.ts";

export enum GoalStatus {
  STATUS_UNKNOWN = 0,
  STATUS_ACCEPTED = 1,
  STATUS_EXECUTING = 2,
  STATUS_CANCELING = 3,
  STATUS_SUCCEEDED = 4,
  STATUS_CANCELED = 5,
  STATUS_ABORTED = 6,
}

export enum GoalResponse {
  REJECT = 1,
  ACCEPT = 2,
}

export enum CancelResponse {
  REJECT = 1,
  ACCEPT = 2,
}

const CANCEL_ERROR_NONE = 0;
const CANCEL_ERROR_REJECTED = 1;
const CANCEL_ERROR_UNKNOWN_GOAL_ID = 2;
const CANCEL_ERROR_GOAL_TERMINATED = 3;

type UUIDMsg = { uuid: Uint8Array | number[] };
type TimeMsg = { sec: number; nanosec: number };

/** 16-byte goal identifier. */
export class ActionUuid {
  readonly bytes: Uint8Array;
  constructor(bytes?: Uint8Array | number[]) {
    this.bytes = bytes ? Uint8Array.from(bytes) : new Uint8Array(randomBytes(16));
    if (this.bytes.length !== 16) throw new TypeError("UUID must have 16 bytes");
  }
  static random(): ActionUuid { return new ActionUuid(); }
  static fromBytes(b: Uint8Array | number[]): ActionUuid { return new ActionUuid(b); }
  static fromMessage(m: UUIDMsg): ActionUuid { return new ActionUuid(m.uuid); }
  static randomMessage(): UUIDMsg { return new ActionUuid().toMessage(); }
  toMessage(): UUIDMsg { return { uuid: Uint8Array.from(this.bytes) }; }
  toString(): string {
    const h = Buffer.from(this.bytes).toString("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
}

const key = (u: UUIDMsg) => Buffer.from(Uint8Array.from(u.uuid)).toString("hex");
const isTerminal = (s: number) => s === GoalStatus.STATUS_SUCCEEDED || s === GoalStatus.STATUS_CANCELED || s === GoalStatus.STATUS_ABORTED;
const timeNs = (t: TimeMsg) => BigInt(t.sec) * 1_000_000_000n + BigInt(t.nanosec);

export interface ActionQoS {
  goalServiceQosProfile?: QoS | string;
  resultServiceQosProfile?: QoS | string;
  cancelServiceQosProfile?: QoS | string;
  feedbackSubQosProfile?: QoS | string;
  statusSubQosProfile?: QoS | string;
}

// Like rcl_action: the action name is expanded and remapped first, then the
// /_action/* entity names are derived from the result.
const names = (node: Node, actionName: string) => {
  const action = node.resolveTopicName(actionName);
  return {
    sendGoal: `${action}/_action/send_goal`,
    cancelGoal: `${action}/_action/cancel_goal`,
    getResult: `${action}/_action/get_result`,
    feedback: `${action}/_action/feedback`,
    status: `${action}/_action/status`,
  };
};

// ============================================================================
// client

export class ClientGoalHandle<G = any, R = any, F = any> {
  readonly goalId: UUIDMsg;
  readonly stamp: TimeMsg;
  readonly accepted: boolean;
  status: GoalStatus;
  #client: ActionClient<string, G, R, F>;
  #result: Promise<R> | undefined;

  /** @internal */
  constructor(client: ActionClient<string, G, R, F>, goalId: UUIDMsg, accepted: boolean, stamp: TimeMsg) {
    this.#client = client;
    this.goalId = goalId;
    this.accepted = accepted;
    this.stamp = stamp;
    this.status = accepted ? GoalStatus.STATUS_ACCEPTED : GoalStatus.STATUS_UNKNOWN;
  }

  isAccepted() { return this.accepted; }
  isExecuting() { return this.status === GoalStatus.STATUS_EXECUTING; }
  isCanceling() { return this.status === GoalStatus.STATUS_CANCELING; }
  isSucceeded() { return this.status === GoalStatus.STATUS_SUCCEEDED; }
  isCanceled() { return this.status === GoalStatus.STATUS_CANCELED; }
  isAborted() { return this.status === GoalStatus.STATUS_ABORTED; }

  cancelGoal(): Promise<{ return_code: number; goals_canceling: any[] }> {
    return this.#client._cancel(this);
  }

  /** Resolves with the result message once the goal terminates. */
  getResult(): Promise<R> {
    this.#result ??= this.#client._getResult(this);
    return this.#result;
  }
}

export class ActionClient<K extends KnownOr<ActionTypeName> = string, G = GoalOf<K>, R = ResultOf<K>, F = FeedbackOf<K>> {
  readonly typeClass: ActionType;
  readonly actionName: string;
  #node: Node;
  #sendGoal: Client;
  #cancelGoal: Client;
  #getResult: Client;
  #feedbackSub: Subscription;
  #statusSub: Subscription;
  #feedbackCallbacks = new Map<string, (f: F) => void>();
  #handles = new Map<string, ClientGoalHandle<G, R, F>>();
  #destroyed = false;

  constructor(node: Node, typeClass: K | Exclude<TypeName, string>, actionName: string, options: ActionQoS = {}) {
    this.#node = node;
    this.typeClass = getActionType(typeClass);
    this.actionName = actionName;
    const n = names(node, actionName);
    const at = this.typeClass;
    this.#sendGoal = node.createClient(at.sendGoal, n.sendGoal, { qos: options.goalServiceQosProfile ?? QoS.profileServicesDefault });
    this.#cancelGoal = node.createClient(getServiceType("action_msgs/srv/CancelGoal"), n.cancelGoal, {
      qos: options.cancelServiceQosProfile ?? QoS.profileServicesDefault,
    });
    this.#getResult = node.createClient(at.getResult, n.getResult, { qos: options.resultServiceQosProfile ?? QoS.profileServicesDefault });
    this.#feedbackSub = node.createSubscription(at.feedbackMessage, n.feedback, { qos: options.feedbackSubQosProfile ?? QoS.profileDefault }, (m: any) => {
      this.#feedbackCallbacks.get(key(m.goal_id))?.(m.feedback);
    });
    this.#statusSub = node.createSubscription(
      getMessageType("action_msgs/msg/GoalStatusArray"),
      n.status,
      { qos: options.statusSubQosProfile ?? QoS.profileActionStatusDefault },
      (m: any) => {
        for (const s of m.status_list) {
          const h = this.#handles.get(key(s.goal_info.goal_id));
          if (h) h.status = s.status;
        }
      },
    );
  }

  /** Sends a goal; resolves with a handle (handle.accepted === false if rejected). */
  async sendGoal(goal: MessageInput<G>, feedbackCallback?: (feedback: F) => void, goalUuid?: UUIDMsg): Promise<ClientGoalHandle<G, R, F>> {
    const goalId = goalUuid ?? ActionUuid.randomMessage();
    if (feedbackCallback) this.#feedbackCallbacks.set(key(goalId), feedbackCallback);
    const resp: any = await this.#sendGoal.sendRequestAsync({ goal_id: goalId, goal });
    const h = new ClientGoalHandle<G, R, F>(this as unknown as ActionClient<string, G, R, F>, goalId, resp.accepted, resp.stamp);
    if (h.accepted) this.#handles.set(key(goalId), h);
    else this.#feedbackCallbacks.delete(key(goalId));
    return h;
  }

  /** @internal */
  async _getResult(h: ClientGoalHandle<G, R, F>): Promise<R> {
    const resp: any = await this.#getResult.sendRequestAsync({ goal_id: h.goalId });
    h.status = resp.status;
    this.#feedbackCallbacks.delete(key(h.goalId));
    this.#handles.delete(key(h.goalId));
    return resp.result;
  }

  /** @internal */
  _cancel(h: ClientGoalHandle<G, R, F>): Promise<any> {
    return this.#cancelGoal.sendRequestAsync({ goal_info: { goal_id: h.goalId, stamp: { sec: 0, nanosec: 0 } } });
  }

  /** Cancels all goals (or those accepted at/before `stamp`). */
  cancelAllGoals(stamp: TimeMsg = { sec: 0, nanosec: 0 }): Promise<any> {
    return this.#cancelGoal.sendRequestAsync({ goal_info: { goal_id: { uuid: new Uint8Array(16) }, stamp } });
  }

  isActionServerAvailable(): boolean {
    return this.#sendGoal.isServiceServerAvailable() && this.#cancelGoal.isServiceServerAvailable() && this.#getResult.isServiceServerAvailable();
  }

  async waitForServer(timeout?: number): Promise<boolean> {
    const deadline = timeout === undefined ? Infinity : Date.now() + timeout;
    let delay = 10;
    for (;;) {
      if (this.isActionServerAvailable()) return true;
      const left = deadline - Date.now();
      if (left <= 0 || this.#destroyed) return false;
      await Bun.sleep(Math.min(delay, left));
      delay = Math.min(delay * 2, 1000);
    }
  }

  /** Like waitForServer but throws ActionServerNotFoundError on timeout. */
  async ensureServer(timeout: number): Promise<void> {
    if (!(await this.waitForServer(timeout))) throw new ActionServerNotFoundError(`action server ${this.actionName} not available`);
  }

  isDestroyed(): boolean {
    return this.#destroyed;
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    if (this.#node.isDestroyed()) return;
    this.#node.destroyClient(this.#sendGoal);
    this.#node.destroyClient(this.#cancelGoal);
    this.#node.destroyClient(this.#getResult);
    this.#node.destroySubscription(this.#feedbackSub);
    this.#node.destroySubscription(this.#statusSub);
  }
}

// ============================================================================
// server

export class ServerGoalHandle<G = any, R = any, F = any> {
  readonly request: G;
  readonly goalId: UUIDMsg;
  readonly stamp: TimeMsg;
  #status: GoalStatus = GoalStatus.STATUS_ACCEPTED;
  #server: ActionServer<string, G, R, F>;
  /** @internal */
  _result: MessageInput<R> | undefined;
  /** @internal */
  _waiters: ServiceResponse[] = [];

  /** @internal */
  constructor(server: ActionServer<string, G, R, F>, goalId: UUIDMsg, request: G, stamp: TimeMsg) {
    this.#server = server;
    this.goalId = goalId;
    this.request = request;
    this.stamp = stamp;
  }

  get status(): GoalStatus {
    return this.#status;
  }

  get isActive(): boolean {
    return !isTerminal(this.#status);
  }

  get isCancelRequested(): boolean {
    return this.#status === GoalStatus.STATUS_CANCELING;
  }

  /** @internal */
  _setStatus(s: GoalStatus): void {
    if (this.#status === s) return;
    if (isTerminal(this.#status)) throw new Error(`goal ${ActionUuid.fromMessage(this.goalId)} already terminated`);
    this.#status = s;
    this.#server._statusChanged(this);
  }

  /** Starts execution (runs the server's execute callback unless `cb` is given). */
  execute(cb?: ExecuteCallback<G, R, F>): void {
    this.#server._execute(this, cb);
  }

  publishFeedback(feedback: MessageInput<F>): void {
    this.#server._publishFeedback(this, feedback);
  }

  succeed(): void { this._setStatus(GoalStatus.STATUS_SUCCEEDED); }
  abort(): void { this._setStatus(GoalStatus.STATUS_ABORTED); }
  canceled(): void { this._setStatus(GoalStatus.STATUS_CANCELED); }
}

export type ExecuteCallback<G, R, F> = (gh: ServerGoalHandle<G, R, F>) => MessageInput<R> | void | Promise<MessageInput<R> | void>;

export interface ActionServerOptions extends ActionQoS {
  /** Seconds a finished goal's result is kept for get_result (default 900). */
  resultTimeout?: number;
}

export class ActionServer<K extends KnownOr<ActionTypeName> = string, G = GoalOf<K>, R = ResultOf<K>, F = FeedbackOf<K>> {
  readonly typeClass: ActionType;
  readonly actionName: string;
  #node: Node;
  #execute: ExecuteCallback<G, R, F>;
  #goalCb: (goal: G) => GoalResponse | Promise<GoalResponse>;
  #acceptedCb: (gh: ServerGoalHandle<G, R, F>) => void;
  #cancelCb: (gh: ServerGoalHandle<G, R, F>) => CancelResponse | Promise<CancelResponse>;
  #goals = new Map<string, ServerGoalHandle<G, R, F>>();
  #services: Service[] = [];
  #feedbackPub: Publisher;
  #statusPub: Publisher;
  #resultTimeoutMs: number;
  #destroyed = false;
  #logger: Logging;

  constructor(
    node: Node,
    typeClass: K | Exclude<TypeName, string>,
    actionName: string,
    executeCallback: ExecuteCallback<G, R, F>,
    goalCallback?: (goal: G) => GoalResponse | Promise<GoalResponse>,
    handleAcceptedCallback?: (gh: ServerGoalHandle<G, R, F>) => void,
    cancelCallback?: (gh: ServerGoalHandle<G, R, F>) => CancelResponse | Promise<CancelResponse>,
    options: ActionServerOptions = {},
  ) {
    this.#node = node;
    this.typeClass = getActionType(typeClass);
    this.actionName = actionName;
    this.#execute = executeCallback;
    this.#goalCb = goalCallback ?? (() => GoalResponse.ACCEPT);
    this.#acceptedCb = handleAcceptedCallback ?? ((gh) => gh.execute());
    this.#cancelCb = cancelCallback ?? (() => CancelResponse.REJECT);
    this.#resultTimeoutMs = (options.resultTimeout ?? 900) * 1000;
    this.#logger = node.getLogger().getChild(`action.${actionName.replace(/\//g, ".")}`);
    const n = names(node, actionName);
    const at = this.typeClass;
    this.#services.push(
      node.createService(at.sendGoal, n.sendGoal, { qos: options.goalServiceQosProfile ?? QoS.profileServicesDefault }, (req: any, res) => {
        void this.#onGoal(req, res);
      }),
      node.createService(getServiceType("action_msgs/srv/CancelGoal"), n.cancelGoal, { qos: options.cancelServiceQosProfile ?? QoS.profileServicesDefault }, (req: any, res) => {
        void this.#onCancel(req, res);
      }),
      node.createService(at.getResult, n.getResult, { qos: options.resultServiceQosProfile ?? QoS.profileServicesDefault }, (req: any, res) => {
        this.#onGetResult(req, res);
      }),
    );
    this.#feedbackPub = node.createPublisher(at.feedbackMessage, n.feedback, { qos: options.feedbackSubQosProfile ?? QoS.profileDefault });
    this.#statusPub = node.createPublisher(getMessageType("action_msgs/msg/GoalStatusArray"), n.status, {
      qos: options.statusSubQosProfile ?? QoS.profileActionStatusDefault,
    });
  }

  registerExecuteCallback(cb: ExecuteCallback<G, R, F>): void { this.#execute = cb; }
  registerGoalCallback(cb: (goal: G) => GoalResponse | Promise<GoalResponse>): void { this.#goalCb = cb; }
  registerCancelCallback(cb: (gh: ServerGoalHandle<G, R, F>) => CancelResponse | Promise<CancelResponse>): void { this.#cancelCb = cb; }
  registerHandleAcceptedCallback(cb: (gh: ServerGoalHandle<G, R, F>) => void): void { this.#acceptedCb = cb; }

  async #onGoal(req: { goal_id: UUIDMsg; goal: G }, res: ServiceResponse): Promise<void> {
    let decision: GoalResponse;
    try {
      decision = await this.#goalCb(req.goal);
    } catch (e) {
      this.#logger.error(`goal callback failed: ${String(e)}`);
      decision = GoalResponse.REJECT;
    }
    const stamp = this.#node.now().toMsg();
    if (decision !== GoalResponse.ACCEPT || this.#goals.has(key(req.goal_id))) {
      res.send({ accepted: false, stamp });
      return;
    }
    const gh = new ServerGoalHandle<G, R, F>(this as unknown as ActionServer<string, G, R, F>, req.goal_id, req.goal, stamp);
    this.#goals.set(key(req.goal_id), gh);
    res.send({ accepted: true, stamp });
    this.#publishStatus();
    try {
      this.#acceptedCb(gh);
    } catch (e) {
      this.#logger.error(`handle accepted callback failed: ${String(e)}`);
    }
  }

  /** @internal */
  _execute(gh: ServerGoalHandle<G, R, F>, cb?: ExecuteCallback<G, R, F>): void {
    if (gh.status === GoalStatus.STATUS_ACCEPTED) gh._setStatus(GoalStatus.STATUS_EXECUTING);
    const run = cb ?? this.#execute;
    Promise.resolve()
      .then(() => run(gh))
      .then(
        (result) => {
          if (gh.isActive) {
            this.#logger.warn(`goal ${ActionUuid.fromMessage(gh.goalId)} still active after execute returned; aborting`);
            gh.abort();
          }
          this.#finish(gh, result);
        },
        (e) => {
          this.#logger.error(`execute callback failed: ${String((e as Error)?.stack ?? e)}`);
          if (gh.isActive) gh.abort();
          this.#finish(gh, undefined);
        },
      );
  }

  #finish(gh: ServerGoalHandle<G, R, F>, result: MessageInput<R> | void | undefined): void {
    gh._result = result ?? this.typeClass.result.create();
    for (const w of gh._waiters) w.send({ status: gh.status, result: gh._result });
    gh._waiters = [];
    const t = setTimeout(() => {
      this.#goals.delete(key(gh.goalId));
      this.#publishStatus();
    }, this.#resultTimeoutMs);
    (t as unknown as { unref?: () => void }).unref?.();
  }

  /** @internal */
  _statusChanged(_gh: ServerGoalHandle<G, R, F>): void {
    this.#publishStatus();
  }

  /** @internal */
  _publishFeedback(gh: ServerGoalHandle<G, R, F>, feedback: MessageInput<F>): void {
    if (this.#destroyed) return;
    this.#feedbackPub.publish({ goal_id: gh.goalId, feedback });
  }

  #publishStatus(): void {
    if (this.#destroyed) return;
    this.#statusPub.publish({
      status_list: [...this.#goals.values()].map((g) => ({ goal_info: { goal_id: g.goalId, stamp: g.stamp }, status: g.status })),
    });
  }

  async #onCancel(req: { goal_info: { goal_id: UUIDMsg; stamp: TimeMsg } }, res: ServiceResponse): Promise<void> {
    const zeroId = Uint8Array.from(req.goal_info.goal_id.uuid).every((b) => b === 0);
    const stampNs = timeNs(req.goal_info.stamp);
    const candidates = [...this.#goals.values()].filter((g) => {
      if (!zeroId && key(g.goalId) === key(req.goal_info.goal_id)) return true;
      if (zeroId && stampNs === 0n) return true;
      return stampNs !== 0n && timeNs(g.stamp) <= stampNs;
    });
    if (candidates.length === 0) {
      res.send({ return_code: zeroId ? CANCEL_ERROR_NONE : CANCEL_ERROR_UNKNOWN_GOAL_ID, goals_canceling: [] });
      return;
    }
    const active = candidates.filter((g) => g.isActive);
    if (active.length === 0) {
      res.send({ return_code: CANCEL_ERROR_GOAL_TERMINATED, goals_canceling: [] });
      return;
    }
    const canceling: any[] = [];
    for (const g of active) {
      let r: CancelResponse;
      try {
        r = await this.#cancelCb(g);
      } catch {
        r = CancelResponse.REJECT;
      }
      if (r === CancelResponse.ACCEPT && g.isActive) {
        if (g.status !== GoalStatus.STATUS_CANCELING) g._setStatus(GoalStatus.STATUS_CANCELING);
        canceling.push({ goal_id: g.goalId, stamp: g.stamp });
      }
    }
    res.send({ return_code: canceling.length ? CANCEL_ERROR_NONE : CANCEL_ERROR_REJECTED, goals_canceling: canceling });
  }

  #onGetResult(req: { goal_id: UUIDMsg }, res: ServiceResponse): void {
    const g = this.#goals.get(key(req.goal_id));
    if (!g) {
      res.send({ status: GoalStatus.STATUS_UNKNOWN, result: this.typeClass.result.create() });
      return;
    }
    if (!g.isActive && g._result !== undefined) {
      res.send({ status: g.status, result: g._result });
      return;
    }
    g._waiters.push(res);
  }

  isDestroyed(): boolean {
    return this.#destroyed;
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    if (this.#node.isDestroyed()) return;
    for (const s of this.#services) this.#node.destroyService(s);
    this.#node.destroyPublisher(this.#feedbackPub);
    this.#node.destroyPublisher(this.#statusPub);
  }
}
