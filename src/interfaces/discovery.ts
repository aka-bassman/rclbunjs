// Locates ROS 2 interface definitions (.msg/.srv/.action/.idl) and their
// typesupport libraries through AMENT_PREFIX_PATH.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type InterfaceKind = "msg" | "srv" | "action";

export function amentPrefixes(): string[] {
  return (process.env.AMENT_PREFIX_PATH ?? "").split(":").filter(Boolean);
}

/** Prefix that owns `pkg` (has share/<pkg>), first match wins like ament. */
export function packagePrefix(pkg: string): string | undefined {
  for (const p of amentPrefixes()) {
    if (existsSync(join(p, "share", pkg, "package.xml")) || existsSync(join(p, "share", pkg))) return p;
  }
  return undefined;
}

export interface InterfaceSource {
  path: string;
  format: "rosidl" | "idl";
  text: string;
}

/** Reads the definition of pkg/<kind>/<name>, preferring .msg/.srv/.action over .idl. */
export function readInterface(pkg: string, kind: InterfaceKind, name: string): InterfaceSource | undefined {
  for (const p of amentPrefixes()) {
    const dir = join(p, "share", pkg, kind);
    const native = join(dir, `${name}.${kind}`);
    if (existsSync(native)) return { path: native, format: "rosidl", text: readFileSync(native, "utf8") };
    const idl = join(dir, `${name}.idl`);
    if (existsSync(idl)) return { path: idl, format: "idl", text: readFileSync(idl, "utf8") };
  }
  return undefined;
}

/** Packages that registered interfaces in the ament index. */
export function listInterfacePackages(): string[] {
  const out = new Set<string>();
  for (const p of amentPrefixes()) {
    const dir = join(p, "share", "ament_index", "resource_index", "rosidl_interfaces");
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) out.add(f);
  }
  return [...out].sort();
}

/** Interfaces of a package as 'pkg/kind/Name' strings (from the ament index). */
export function listInterfaces(pkg: string): string[] {
  for (const p of amentPrefixes()) {
    const f = join(p, "share", "ament_index", "resource_index", "rosidl_interfaces", pkg);
    if (!existsSync(f)) continue;
    const names = new Set<string>();
    for (const line of readFileSync(f, "utf8").split("\n")) {
      const m = /^(msg|srv|action)\/([A-Za-z0-9_]+)\.(idl|msg|srv|action)$/.exec(line.trim());
      if (m) names.add(`${pkg}/${m[1]}/${m[2]}`);
    }
    return [...names].sort();
  }
  return [];
}

/** Absolute path of lib<pkg>__<suffix>.so (or .dylib) in the owning prefix. */
export function packageLibrary(pkg: string, suffix: string): string | undefined {
  const exts = process.platform === "darwin" ? [".dylib"] : [".so"];
  for (const p of amentPrefixes()) {
    for (const ext of exts) {
      const f = join(p, "lib", `lib${pkg}__${suffix}${ext}`);
      if (existsSync(f)) return f;
    }
  }
  return undefined;
}
