// rclbunjs public API (shaped after rclnodejs).

/** Message types by name; filled in by `bunx rclbunjs-typegen` (declaration merging). */
// biome-ignore lint/suspicious/noEmptyInterface: augmented by generated declarations
export interface MessageTypeMap {}
/** Service types by name: { Request, Response }. */
// biome-ignore lint/suspicious/noEmptyInterface: augmented by generated declarations
export interface ServiceTypeMap {}
/** Action types by name: { Goal, Result, Feedback }. */
// biome-ignore lint/suspicious/noEmptyInterface: augmented by generated declarations
export interface ActionTypeMap {}
export type * from "./types.ts";
import type { KnownOr, MessageOf, MessageTypeName } from "./types.ts";
import { Context } from "./core/context.ts";
import { Node, NodeOptions, type NodeOptionsInit } from "./core/node.ts";
import { TimeoutError } from "./core/errors.ts";
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

export { Context } from "./core/context.ts";
export { Node, NodeOptions } from "./core/node.ts";
export type { NamesAndTypes, TopicEndpointInfo, NodeOptionsInit } from "./core/node.ts";
export { Publisher } from "./core/publisher.ts";
export { Subscription, MessageInfo } from "./core/subscription.ts";
export type { ContentFilter, SubscriptionCallback } from "./core/subscription.ts";
export { PublisherEventCallbacks, SubscriptionEventCallbacks } from "./core/event_handler.ts";
export { Client } from "./core/client.ts";
export { Service, ServiceResponse } from "./core/service.ts";
export { Timer, GuardCondition, Rate } from "./core/timer.ts";
export type { TimerInfo } from "./core/timer.ts";
export { QoS, HistoryPolicy, ReliabilityPolicy, DurabilityPolicy, LivelinessPolicy, QoSPolicyKind } from "./core/qos.ts";
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
export * from "./core/errors.ts";
export { toJSONSafe, toJSONString } from "./core/entity.ts";
export { getMessageType, getServiceType, getActionType } from "./interfaces/registry.ts";
export type { MessageType, ServiceType, ActionType, TypeName } from "./interfaces/registry.ts";

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

/** Resolves with the next message on `topic` (the node must be spinning). */
export function waitForMessage<K extends KnownOr<MessageTypeName>, T = MessageOf<K>>(
  typeClass: K | Exclude<TypeName, string>,
  node: Node,
  topic: string,
  options: { timeout?: number; qos?: QoS | string } = {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sub = node.createSubscription(typeClass, topic, { qos: options.qos }, (msg) => {
      if (timer) clearTimeout(timer);
      queueMicrotask(() => node.destroySubscription(sub));
      resolve(msg as T);
    });
    if (options.timeout !== undefined) {
      timer = setTimeout(() => {
        node.destroySubscription(sub);
        reject(new TimeoutError(`no message on ${topic} within ${options.timeout} ms`));
      }, options.timeout);
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

export function serializeMessage(msg: unknown, type: TypeName): Uint8Array {
  return getMessageType(type).encode(msg);
}

export function deserializeMessage<T = any>(bytes: Uint8Array, type: TypeName): T {
  return getMessageType(type).decode(bytes);
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

/** Actions visible in the graph (derived from their feedback topics, like rcl_action). */
export function getActionNamesAndTypes(node: Node): { name: string; types: string[] }[] {
  const suffix = "/_action/feedback";
  return node
    .getTopicNamesAndTypes()
    .filter((t) => t.name.endsWith(suffix))
    .map((t) => ({ name: t.name.slice(0, -suffix.length), types: t.types.map((ty) => ty.replace(/_FeedbackMessage$/, "")) }));
}

/** Installed interface packages / interfaces (from the ament index). */
export const interfaces = { packages: listInterfacePackages, list: listInterfaces };

let signalHandler: (() => void) | null = () => shutdownAll();
process.on("SIGINT", signalHandler);

export function removeSignalHandlers(): void {
  if (signalHandler) process.off("SIGINT", signalHandler);
  signalHandler = null;
}

const rclbun = {
  init,
  shutdown,
  shutdownAll,
  isShutdown,
  createNode,
  createLifecycleNode,
  spin,
  spinOnce,
  removeROSArgs,
  removeSignalHandlers,
  waitForMessage,
  getActionNamesAndTypes,
  require,
  createMessageObject,
  serializeMessage,
  deserializeMessage,
  isTopicOrServiceHidden,
  expandTopicName,
  toJSONSafe,
  toJSONString,
  interfaces,
  Context,
  Node,
  NodeOptions,
  QoS,
};
export default rclbun;
