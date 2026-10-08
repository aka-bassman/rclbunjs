// Helpers over the type maps declared in index.ts (augmented by the generated
// declarations from `bunx rclbunjs-typegen`).
import type { ActionTypeMap, MessageTypeMap, ServiceTypeMap } from "./index.ts";

export type MessageTypeName = keyof MessageTypeMap & string;
export type ServiceTypeName = keyof ServiceTypeMap & string;
export type ActionTypeName = keyof ActionTypeMap & string;

/** Autocompletes known names but still accepts any string. */
export type KnownOr<K extends string> = K | (string & {});

export type MessageOf<T> = T extends keyof MessageTypeMap ? MessageTypeMap[T] : any;
export type RequestOf<T> = T extends keyof ServiceTypeMap ? (ServiceTypeMap[T] extends { Request: infer R } ? R : any) : any;
export type ResponseOf<T> = T extends keyof ServiceTypeMap ? (ServiceTypeMap[T] extends { Response: infer R } ? R : any) : any;
export type GoalOf<T> = T extends keyof ActionTypeMap ? (ActionTypeMap[T] extends { Goal: infer R } ? R : any) : any;
export type ResultOf<T> = T extends keyof ActionTypeMap ? (ActionTypeMap[T] extends { Result: infer R } ? R : any) : any;
export type FeedbackOf<T> = T extends keyof ActionTypeMap ? (ActionTypeMap[T] extends { Feedback: infer R } ? R : any) : any;

/** Message input: every field optional (missing fields get their default values). */
export type MessageInput<T> = T extends bigint | number | string | boolean
  ? T
  : T extends ArrayLike<infer E> & object
    ? T | ArrayLike<E>
    : T extends object
      ? { [K in keyof T]?: MessageInput<T[K]> }
      : T;
