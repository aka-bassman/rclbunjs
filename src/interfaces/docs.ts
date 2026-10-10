// Comments of .msg/.srv/.action and .idl files, for JSDoc in generated declarations.
//
// .msg files follow rosidl_adapter (parser.py, parse_message_string and
// process_comments), so a .msg and the .idl rosidl generates from it give the
// same docs:
// - the comment lines at the very top of a file (or of a .srv/.action section)
//   describe the message;
// - other comment lines describe the next field or constant, blank lines in
//   between or not, and a comment at the end of its line is added after them;
// - an indented comment line continues the previous field or constant;
// - a single `[...]` in a comment (no comma) is the unit, taken out of the text;
// - leading, trailing and repeated blank lines are dropped, and lines dedented.
// In .idl files the documentation is the `@verbatim (language="comment",
// text=...)` annotation of a struct, member or constant and the `@unit` of a
// member; plain // and /* */ comments are not documentation there.

export interface StructDocs {
  /** description of the message */
  doc?: string;
  /** field and constant name -> description */
  members: Map<string, string>;
  /** field name -> unit */
  units: Map<string, string>;
}

const emptyDocs = (): StructDocs => ({ members: new Map(), units: new Map() });

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

/** textwrap.dedent: removes the leading whitespace common to all non-blank lines. */
function dedent(lines: string[]): string[] {
  const ls = lines.map((l) => (/^[ \t]*$/.test(l) ? "" : l));
  let margin: string | undefined;
  for (const l of ls) {
    if (!l) continue;
    const ws = /^[ \t]*/.exec(l)![0];
    if (margin === undefined) margin = ws;
    let k = 0;
    while (k < margin.length && margin[k] === ws[k]) k++;
    margin = margin.slice(0, k);
  }
  return margin ? ls.map((l) => l.slice(margin.length)) : ls;
}

/** rosidl_adapter's process_comments: the unit, then the condensed, dedented text. */
function condense(raw: string[]): { text?: string; unit?: string } {
  let lines = raw;
  let unit: string | undefined;
  const units = [...lines.join("\n").matchAll(/(\s*\[([^,\]]+)\])/g)];
  if (units.length === 1) {
    unit = units[0]![2];
    lines = lines.map((l) => l.split(units[0]![1]!).join(""));
  }
  while (lines.length && lines[0] === "") lines = lines.slice(1);
  while (lines.length && lines[lines.length - 1] === "") lines = lines.slice(0, -1);
  lines = lines.filter((l, i) => !(l === "" && lines[i - 1] === ""));
  return { text: lines.length ? dedent(lines).join("\n") : undefined, unit };
}

const commentText = (s: string) => s.replace(/^#+/, "");

function parseSection(text: string): StructDocs {
  const out = emptyDocs();
  const lines = text.replace(/\t/g, " ").split(/\r?\n/);
  let top = lines.findIndex((l) => !l.startsWith("#"));
  if (top < 0) top = lines.length;
  const elements: { name: string; field: boolean; comments: string[] }[] = [];
  let pending: string[] = [];
  for (let line of lines.slice(top)) {
    line = line.trimEnd();
    if (!line) continue;
    const at = commentStart(line);
    if (at >= 0) {
      const comment = commentText(line.slice(at));
      line = line.slice(0, at);
      if (line && !line.trim()) {
        // indented comment line: continues the previous field or constant
        elements[elements.length - 1]?.comments.push(comment);
        continue;
      }
      pending.push(comment);
      line = line.trimEnd();
      if (!line) continue;
    }
    const rest = line.includes(" ") ? line.slice(line.indexOf(" ") + 1).trimStart() : "";
    if (!rest) continue;
    const field = !rest.includes("=");
    const name = field ? rest.split(" ")[0]! : rest.slice(0, rest.indexOf("=")).trimEnd();
    elements.push({ name, field, comments: pending });
    pending = [];
  }
  out.doc = condense(lines.slice(0, top).map(commentText)).text;
  for (const e of elements) {
    const { text, unit } = condense(e.comments);
    if (text) out.members.set(e.name, text);
    if (unit !== undefined && e.field) out.units.set(e.name, unit);
  }
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
  SECTIONS[kind]!.forEach((suffix, i) => out.set(suffix, parseSection((sections[i] ?? []).join("\n"))));
  return out;
}

type IdlToken = { kind: "id" | "str" | "num" | "punct"; text: string };

const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", "0": "\0" };

function tokenizeIdl(text: string): IdlToken[] {
  const out: IdlToken[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (c === "/" && text[i + 1] === "/") {
      i = text.indexOf("\n", i) < 0 ? text.length : text.indexOf("\n", i);
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) < 0 ? text.length : text.indexOf("*/", i + 2) + 2;
    } else if (c === "#") {
      // preprocessor line (#include, #pragma)
      i = text.indexOf("\n", i) < 0 ? text.length : text.indexOf("\n", i);
    } else if (c === '"' || c === "'") {
      let s = "";
      for (i++; i < text.length && text[i] !== c; i++) {
        if (text[i] === "\\") s += ESCAPES[text[++i]!] ?? text[i] ?? "";
        else s += text[i];
      }
      i++;
      out.push({ kind: "str", text: s });
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i))![0];
      out.push({ kind: "id", text: m });
      i += m.length;
    } else if (/[0-9.]/.test(c)) {
      const m = /^[0-9.]+(?:[eE][+-]?[0-9]+)?[A-Za-z0-9_]*/.exec(text.slice(i))?.[0] || c;
      out.push({ kind: "num", text: m });
      i += m.length;
    } else if (c === ":" && text[i + 1] === ":") {
      out.push({ kind: "punct", text: "::" });
      i += 2;
    } else {
      out.push({ kind: "punct", text: c });
      i++;
    }
  }
  return out;
}

/** Parameters of an annotation, `(key=value, ...)`; adjacent strings are concatenated. */
function annotationParams(tokens: IdlToken[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]!.kind !== "id" || tokens[i + 1]?.text !== "=") continue;
    const key = tokens[i]!.text;
    let value = "";
    for (i += 2; i < tokens.length && tokens[i]!.text !== ","; i++) value += tokens[i]!.text;
    out.set(key, value);
  }
  return out;
}

/**
 * Docs of an .idl file, keyed by struct name ("Header", "AddTwoInts_Request").
 * Constants are declared in a `<Struct>_Constants` module and documented as
 * members of that struct.
 */
export function parseIdlDocs(text: string): Map<string, StructDocs> {
  const tokens = tokenizeIdl(text);
  const out = new Map<string, StructDocs>();
  const docsOf = (name: string) => {
    if (!out.has(name)) out.set(name, emptyDocs());
    return out.get(name)!;
  };
  const scopes: { kind: string; name: string }[] = [];
  let pending: string[] = [];
  let unit: string | undefined;
  let decl: IdlToken[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.text === "@" && t.kind === "punct") {
      const name = tokens[++i]?.text;
      if (tokens[i + 1]?.text !== "(") continue;
      const start = i + 2;
      for (let depth = 0; i + 1 < tokens.length; ) {
        const p = tokens[++i]!.text;
        if (p === "(") depth++;
        else if (p === ")" && --depth === 0) break;
      }
      const params = annotationParams(tokens.slice(start, i));
      if (name === "verbatim" && params.get("language") === "comment" && params.has("text")) pending.push(params.get("text")!);
      if (name === "unit" && params.has("value")) unit = params.get("value");
      continue;
    }
    if (t.kind === "punct" && t.text === "{") {
      const [kw, name = ""] = decl.map((d) => d.text);
      scopes.push({ kind: kw ?? "", name });
      if (kw === "struct" && pending.join("").trim()) docsOf(name).doc = pending.join("\n");
    } else if (t.kind === "punct" && t.text === "}") {
      scopes.pop();
    } else if (t.kind === "punct" && t.text === ";") {
      const scope = scopes[scopes.length - 1];
      const doc = pending.join("").trim() ? pending.join("\n") : "";
      let owner: string | undefined;
      let member: string | undefined;
      if (scope?.kind === "struct") {
        // `type name;`, `type name[N];`, `sequence<type, N> name;`: the last identifier outside brackets
        let depth = 0;
        for (const d of decl) {
          if (d.text === "[") depth++;
          else if (d.text === "]") depth--;
          else if (!depth && d.kind === "id") member = d.text;
        }
        owner = scope.name;
      } else if (scope?.kind === "module" && scope.name.endsWith("_Constants")) {
        // `const type NAME = value;`
        const eq = decl.findIndex((d) => d.text === "=");
        member = eq > 0 ? decl[eq - 1]!.text : undefined;
        owner = scope.name.slice(0, -"_Constants".length);
      }
      if (owner && member && doc) docsOf(owner).members.set(member, doc);
      if (owner && member && unit !== undefined && scope?.kind === "struct") docsOf(owner).units.set(member, unit);
    } else {
      decl.push(t);
      continue;
    }
    decl = [];
    pending = [];
    unit = undefined;
  }
  return out;
}

/** A JSDoc block (indented), or "" when there is nothing to say. */
export function jsdoc(indent: string, text: string | undefined, tags: string[] = []): string {
  const body = [...(text ? text.split("\n") : []), ...(text && tags.length ? [""] : []), ...tags].map((l) => l.replace(/\*\//g, "*\\/"));
  if (!body.length) return "";
  if (body.length === 1) return `${indent}/** ${body[0]} */\n`;
  return `${indent}/**\n${body.map((l) => `${indent} *${l ? ` ${l}` : ""}`).join("\n")}\n${indent} */\n`;
}
