// Name validation (rclnodejs lib/validator.js) over rmw/rcl validators.
import { lib } from "../native/loader.ts";
import { cstr } from "../native/ffi.ts";
import { NameValidationError, TypeValidationError } from "./errors.ts";

type Check = (name: Uint8Array) => string | null;

function validate(check: Check, value: unknown, kind: string): true {
  if (typeof value !== "string") throw new TypeValidationError(`${kind} must be a string`, { details: value });
  const err = check(cstr(value));
  if (err) throw new NameValidationError(`invalid ${kind} '${value}': ${err}`, { entityType: kind, entityName: value });
  return true;
}

const isValid = (check: Check, value: unknown) => typeof value === "string" && !check(cstr(value));

const fullTopic: Check = (n) => lib.rb_validate_full_topic_name(n) as string | null;
const topic: Check = (n) => lib.rb_validate_topic_name(n) as string | null;
const node: Check = (n) => lib.rb_validate_node_name(n) as string | null;
const namespace: Check = (n) => lib.rb_validate_namespace(n) as string | null;

export const validator = {
  validateFullTopicName: (name: string) => validate(fullTopic, name, "topic"),
  isValidFullTopicName: (name: unknown) => isValid(fullTopic, name),
  validateTopicName: (name: string) => validate(topic, name, "topic"),
  isValidTopicName: (name: unknown) => isValid(topic, name),
  validateNodeName: (name: string) => validate(node, name, "node"),
  isValidNodeName: (name: unknown) => isValid(node, name),
  validateNamespace: (name: string) => validate(namespace, name, "namespace"),
  isValidNamespace: (name: unknown) => isValid(namespace, name),
};
