// rclbunjs public API (shaped after rclnodejs); re-exported by index.ts.
export type * from "./types.ts";
import type { KnownOr, MessageOf, MessageTypeName } from "./types.ts";
import { Context } from "./core/context.ts";
import { Node, NodeOptions, type NodeOptionsInit } from "./core/node.ts";
import { AbortError, TimeoutError, TypeValidationError } from "./core/errors.ts";
import type { EntityOptions } from "./core/entity.ts";
import type { Subscription } from "./core/subscription.ts";
import { QoS } from "./core/qos.ts";
import { toJSONSafe, toJSONString } from "./core/entity.ts";
import {
  getActionType,
  getMessageType,
  getServiceType,
  interfaceKind,
  type TypeName,
} from "./interfaces/registry.ts";
import { listInterfacePackages, listInterfaces } from "./interfaces/discovery.ts";
import type { DecodeOptions } from "./interfaces/cdr.ts";
import { spawn, type ChildProcess } from "node:child_process";

export { Context } from "./core/context.ts";
export { Node, NodeOptions } from "./core/node.ts";
export type { NamesAndTypes, TopicEndpointInfo, ServiceEndpointInfo, NodeOptionsInit } from "./core/node.ts";
export { ActionEndpointInfo } from "./core/node.ts";
export { Publisher, LoanedMessage } from "./core/publisher.ts";
export { isFixedSizeMessage } from "./core/loaned_message.ts";
export type { MessageView, MessageViewMethods } from "./core/message_view.ts";
export { Subscription, MessageInfo } from "./core/subscription.ts";
export type { ContentFilter, SubscriptionCallback } from "./core/subscription.ts";
export { PublisherEventCallbacks, SubscriptionEventCallbacks } from "./core/event_handler.ts";
export { Client } from "./core/client.ts";
export { Service, ServiceResponse, ServiceIntrospectionStates } from "./core/service.ts";
export { TypeDescriptionService } from "./core/type_description_service.ts";
export { Timer, GuardCondition, Rate } from "./core/timer.ts";
export type { TimerInfo } from "./core/timer.ts";
export { QoS, HistoryPolicy, ReliabilityPolicy, DurabilityPolicy, LivelinessPolicy, QoSPolicyKind } from "./core/qos.ts";
export { QoSOverridingOptions } from "./core/qos_overriding_options.ts";
export type { QoSOverridingResult } from "./core/qos_overriding_options.ts";
export { Clock, ROSClock, ClockChange, ClockEvent } from "./core/clock.ts";
export type { ClockCallbackObject, JumpInfo } from "./core/clock.ts";
export { Time, Duration, ClockType } from "./core/time.ts";
export { Logging, LoggingSeverity } from "./core/logging.ts";
export { TimeSource } from "./core/time_source.ts";
export {
  Parameter,
  ParameterType,
  ParameterDescriptor,
  FloatingPointRange,
  IntegerRange,
  DEFAULT_NUMERIC_RANGE_TOLERANCE,
} from "./core/parameter.ts";
export { ParameterClient } from "./core/parameter_client.ts";
export { ParameterEventHandler, ParameterWatcher } from "./core/parameter_event_handler.ts";
export type { ParameterEvent } from "./core/parameter_event_handler.ts";
export {
  ActionClient,
  ActionServer,
  ActionUuid,
  ClientGoalHandle,
  ServerGoalHandle,
  GoalResponse,
  CancelResponse,
  GoalStatus,
} from "./core/action.ts";
export type { ActionQoS, ActionServerOptions, ExecuteCallback } from "./core/action.ts";
export * as lifecycle from "./core/lifecycle.ts";
import { LifecycleNode } from "./core/lifecycle.ts";

export function createLifecycleNode(
  name: string,
  namespace = "",
  context: Context = Context.defaultContext(),
  options?: NodeOptions | NodeOptionsInit,
  enableCommunicationInterface = true,
): LifecycleNode {
  return new LifecycleNode(name, namespace, context, options, enableCommunicationInterface);
}
export { ObservableSubscription } from "./core/observable_subscription.ts";
export type { ObservableLike, Observer, Unsubscribable } from "./core/observable_subscription.ts";
export { validator } from "./core/validator.ts";
export {
  ValidationProblem,
  getMessageSchema,
  getFieldNames,
  getFieldType,
  validateMessage,
  assertValidMessage,
  createMessageValidator,
} from "./core/message_validation.ts";
export type {
  MessageSchema,
  MessageField,
  MessageFieldType,
  MessageValidationOptions,
  MessageValidationIssue,
  MessageValidationResult,
  MessageValidator,
} from "./core/message_validation.ts";
export { DistroUtils, RMWUtils } from "./core/distro.ts";
export { getActionNamesAndTypes, getActionClientNamesAndTypesByNode, getActionServerNamesAndTypesByNode } from "./core/action_graph.ts";
export { Logging as logging } from "./core/logging.ts";
/** Optional rcl features available in this ROS 2 installation. */
export { features } from "./native/loader.ts";
export * from "./core/errors.ts";
export { toJSONSafe, toJSONString } from "./core/entity.ts";
export { getMessageType, getServiceType, getActionType } from "./interfaces/registry.ts";
export type { MessageType, ServiceType, ActionType, TypeName } from "./interfaces/registry.ts";
export type { DecodeOptions } from "./interfaces/cdr.ts";

/** Initializes `context` (default context) with ROS arguments from `argv`. */
export async function init(context: Context = Context.defaultContext(), argv: string[] = process.argv): Promise<void> {
  context.init(argv);
}

export function shutdown(context: Context = Context.defaultContext()): void {
  context.shutdown();
}

export function shutdownAll(): void {
  for (const c of Context.instances) c.tryShutdown();
}

export function isShutdown(context: Context = Context.defaultContext()): boolean {
  return !context.isInitialized();
}

export function createNode(
  name: string,
  namespace = "",
  context: Context = Context.defaultContext(),
  options?: NodeOptions | NodeOptionsInit,
  args: string[] = [],
  useGlobalArguments = true,
): Node {
  return new Node(name, namespace, context, options, args, useGlobalArguments);
}

/** Starts spinning `node` in the background. */
export function spin(node: Node, timeout = 10): void {
  node.spin(timeout);
}

export function spinOnce(node: Node, timeout = 10): void {
  node.spinOnce(timeout);
}

/** Removes ROS-specific arguments (`--ros-args ... [--]`) from argv. */
export function removeROSArgs(argv: string[]): string[] {
  const out: string[] = [];
  let inRos = false;
  for (const a of argv) {
    if (a === "--ros-args") inRos = true;
    else if (inRos && a === "--") inRos = false;
    else if (!inRos) out.push(a);
  }
  return out;
}

export interface WaitForMessageOptions {
  /** ms; rejects with TimeoutError when no message arrives in time (no timeout by default) */
  timeout?: number;
  qos?: QoS | string;
  /** rejects with AbortError when aborted */
  signal?: AbortSignal;
  /** other subscription options (serializationMode, enableTypedArray, contentFilter, ...) */
  subscriptionOptions?: EntityOptions;
}

/** Resolves with the next message on `topic` (the node must be spinning). */
export function waitForMessage<K extends KnownOr<MessageTypeName>, T = MessageOf<K>>(
  typeClass: K | Exclude<TypeName, string>,
  node: Node,
  topic: string,
  options: WaitForMessageOptions = {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let sub: Subscription<T> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const settle = (err: unknown, msg?: T) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      // the subscription cannot be destroyed from inside its own callback dispatch
      const s = sub;
      queueMicrotask(() => {
        if (s && !node.isDestroyed()) node.destroySubscription(s);
      });
      if (err) reject(err);
      else resolve(msg as T);
    };
    const onAbort = () => settle(new AbortError(`waitForMessage on '${topic}' aborted`, { entityType: "topic", entityName: topic }));
    if (options.signal?.aborted) return onAbort();
    try {
      if (options.subscriptionOptions?.loanedMessages) throw new TypeValidationError("waitForMessage cannot use loanedMessages: views are valid only inside a subscription callback");
      const subOptions: EntityOptions = { ...options.subscriptionOptions, ...(options.qos !== undefined ? { qos: options.qos } : {}) };
      sub = node.createSubscription<K, T>(typeClass, topic, subOptions, (msg: T) => settle(null, msg));
    } catch (e) {
      return settle(e);
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.timeout != null && options.timeout >= 0) {
      timer = setTimeout(
        () => settle(new TimeoutError(`waitForMessage timed out after ${options.timeout}ms on topic '${topic}'`, { entityType: "topic", entityName: topic })),
        options.timeout,
      );
    }
  });
}

/** Interface description for a type name (message, service or action). */
export function require(name: TypeName) {
  const kind = interfaceKind(name);
  if (kind === "srv") return getServiceType(name);
  if (kind === "action") return getActionType(name);
  return getMessageType(name);
}

/** A message object populated with default values. */
export function createMessageObject<T = any>(type: TypeName): T {
  return getMessageType(type).create();
}

/** Same as {@link createMessageObject} (rclnodejs returns a message class instance here). */
export function createMessage<T = any>(type: TypeName): T {
  return createMessageObject<T>(type);
}

export function serializeMessage(msg: unknown, type: TypeName): Uint8Array {
  return getMessageType(type).encode(msg);
}

/** Decodes CDR bytes; with `{ zeroCopy: true }` numeric arrays are views into `bytes`. */
export function deserializeMessage<T = any>(bytes: Uint8Array, type: TypeName, options?: DecodeOptions): T {
  return getMessageType(type).decode(bytes, options);
}

export function isTopicOrServiceHidden(name: string): boolean {
  return name.split("/").some((s) => s.startsWith("_"));
}

/** Expands a relative/private topic name the way rcl does (no remapping). */
export function expandTopicName(topic: string, nodeName: string, namespace = "/"): string {
  let ns = namespace.startsWith("/") ? namespace : `/${namespace}`;
  if (ns.length > 1 && ns.endsWith("/")) ns = ns.slice(0, -1);
  let t = topic.replace(/\{node\}/g, nodeName).replace(/\{ns\}|\{namespace\}/g, ns);
  if (t.startsWith("~")) t = `${ns === "/" ? "" : ns}/${nodeName}${t.slice(1)}`;
  if (!t.startsWith("/")) t = `${ns === "/" ? "" : ns}/${t}`;
  return t;
}


function ros2(verb: "run" | "launch", pkg: string, target: string, args: string[]): Promise<{ process: ChildProcess }> {
  return new Promise((resolve, reject) => {
    if (typeof pkg !== "string" || !pkg.trim()) return reject(new Error("Package name must be a non-empty string"));
    if (typeof target !== "string" || !target.trim()) return reject(new Error(`${verb === "run" ? "Executable" : "Launch file"} name must be a non-empty string`));
    if (!Array.isArray(args)) return reject(new Error("Arguments must be an array"));
    const child = spawn("ros2", [verb, pkg, target, ...args]);
    child.on("error", (e) => reject(new Error(`Failed to start ros2 ${verb}: ${e.message}`)));
    child.on("spawn", () => resolve({ process: child }));
  });
}

/** Starts `ros2 run <pkg> <executable> ...args`; resolves once the process has spawned. */
export function ros2Run(packageName: string, executableName: string, args: string[] = []): Promise<{ process: ChildProcess }> {
  return ros2("run", packageName, executableName, args);
}

/** Starts `ros2 launch <pkg> <launch file> ...args`; resolves once the process has spawned. */
export function ros2Launch(packageName: string, launchFile: string, args: string[] = []): Promise<{ process: ChildProcess }> {
  return ros2("launch", packageName, launchFile, args);
}

/** Installed interface packages / interfaces (from the ament index). */
export const interfaces = { packages: listInterfacePackages, list: listInterfaces };

let signalHandler: (() => void) | null = () => shutdownAll();
process.on("SIGINT", signalHandler);

export function removeSignalHandlers(): void {
  if (signalHandler) process.off("SIGINT", signalHandler);
  signalHandler = null;
}
