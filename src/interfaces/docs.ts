// Comments of .msg/.srv/.action files, for JSDoc in generated declarations.
//
// Follows the rosidl conventions: the comment block at the top of a file (or of
// a .srv/.action section), when a blank line separates it from what follows,
// describes the message; comment lines directly above a field or constant and a
// trailing comment on its line describe that field or constant.

export interface StructDocs {
  /** description of the message */
  doc?: string;
  /** field and constant name -> description */
  members: Map<string, string>;
}

/** Index of the first '#' that is not inside a quoted string, or -1. */
function commentStart(line: string): number {
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "#") {
      return i;
    }
  }
  return -1;
}

const commentText = (s: string) => s.replace(/^#+ ?/, "").trimEnd();

function parseSection(lines: string[]): StructDocs {
  const out: StructDocs = { members: new Map() };
  let pending: string[] = [];
  let seenMember = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("#")) {
      pending.push(commentText(line));
      continue;
    }
    if (!line) {
      // a comment block that ends at a blank line before any member describes the message
      if (!seenMember && out.doc === undefined && pending.length) out.doc = pending.join("\n").trim() || undefined;
      pending = [];
      continue;
    }
    seenMember = true;
    const at = commentStart(line);
    const decl = at >= 0 ? line.slice(0, at) : line;
    const name = decl.trim().split(/\s+/)[1]?.split("=")[0];
    const doc = [...pending, ...(at >= 0 ? [commentText(line.slice(at))] : [])].join("\n").trim();
    if (name && doc) out.members.set(name, doc);
    pending = [];
  }
  if (!seenMember && out.doc === undefined && pending.length) out.doc = pending.join("\n").trim() || undefined;
  return out;
}

const SECTIONS: Record<string, string[]> = {
  msg: [""],
  srv: ["_Request", "_Response"],
  action: ["_Goal", "_Result", "_Feedback"],
};

/**
 * Docs of one interface file, keyed by struct name suffix: "" for a message,
 * "_Request"/"_Response" for a service, "_Goal"/"_Result"/"_Feedback" for an action.
 */
export function parseInterfaceDocs(text: string, kind: "msg" | "srv" | "action"): Map<string, StructDocs> {
  const sections: string[][] = [[]];
  for (const line of text.split(/\r?\n/)) {
    if (kind !== "msg" && line.trim() === "---") sections.push([]);
    else sections[sections.length - 1]!.push(line);
  }
  const out = new Map<string, StructDocs>();
  SECTIONS[kind]!.forEach((suffix, i) => out.set(suffix, parseSection(sections[i] ?? [])));
  return out;
}

/** A JSDoc block (indented), or "" when there is nothing to say. */
export function jsdoc(indent: string, text: string | undefined, tags: string[] = []): string {
  const body = [...(text ? text.split("\n") : []), ...(text && tags.length ? [""] : []), ...tags].map((l) => l.replace(/\*\//g, "*\\/"));
  if (!body.length) return "";
  if (body.length === 1) return `${indent}/** ${body[0]} */\n`;
  return `${indent}/**\n${body.map((l) => `${indent} *${l ? ` ${l}` : ""}`).join("\n")}\n${indent} */\n`;
}
