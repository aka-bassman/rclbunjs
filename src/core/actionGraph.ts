// Action graph queries, derived from feedback topics the way rcl_action does:
// servers publish and clients subscribe to <action>/_action/feedback.
import type { NamesAndTypes, Node } from "./node.ts";

const FEEDBACK = "/_action/feedback";

function actions(topics: NamesAndTypes[]): NamesAndTypes[] {
  return topics
    .filter((t) => t.name.endsWith(FEEDBACK))
    .map((t) => ({ name: t.name.slice(0, -FEEDBACK.length), types: t.types.map((ty) => ty.replace(/_FeedbackMessage$/, "")) }));
}

/** Actions visible in the graph. */
export function getActionNamesAndTypes(node: Node): NamesAndTypes[] {
  return actions(node.getTopicNamesAndTypes());
}

/** Action clients of a remote node. */
export function getActionClientNamesAndTypesByNode(node: Node, nodeName: string, namespace = "/"): NamesAndTypes[] {
  return actions(node.getSubscriptionNamesAndTypesByNode(nodeName, namespace));
}

/** Action servers of a remote node. */
export function getActionServerNamesAndTypesByNode(node: Node, nodeName: string, namespace = "/"): NamesAndTypes[] {
  return actions(node.getPublisherNamesAndTypesByNode(nodeName, namespace));
}
