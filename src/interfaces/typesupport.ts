// Resolves rosidl_typesupport_c handles by dlopen'ing the per-package
// typesupport library and calling its generated getter.
import { dlopen, FFIType, type Pointer } from "bun:ffi";
import { packageLibrary } from "./discovery.ts";
import { InterfaceNotFoundError } from "../core/errors.ts";

const libs = new Map<string, { close(): void }>();
const handles = new Map<string, Pointer>();

function resolve(pkg: string, symbol: string): Pointer {
  const key = `${pkg}:${symbol}`;
  const cached = handles.get(key);
  if (cached) return cached;
  const path = packageLibrary(pkg, "rosidl_typesupport_c");
  if (!path) throw new InterfaceNotFoundError(`typesupport library for package '${pkg}' not found`);
  let h: Pointer | null;
  try {
    const l = dlopen(path, { [symbol]: { returns: FFIType.ptr, args: [] } });
    libs.set(key, l);
    h = (l.symbols as Record<string, () => Pointer | null>)[symbol]!();
  } catch (e) {
    throw new InterfaceNotFoundError(`typesupport symbol ${symbol} not found in ${path}: ${(e as Error).message}`);
  }
  if (!h) throw new InterfaceNotFoundError(`typesupport getter ${symbol} returned NULL`);
  handles.set(key, h);
  return h;
}

/** Message typesupport; `sub` is 'msg', 'srv' or 'action' and `name` may carry a suffix like `_Request`. */
export function messageTypeSupport(pkg: string, sub: string, name: string): Pointer {
  return resolve(pkg, `rosidl_typesupport_c__get_message_type_support_handle__${pkg}__${sub}__${name}`);
}

export function serviceTypeSupport(pkg: string, sub: string, name: string): Pointer {
  return resolve(pkg, `rosidl_typesupport_c__get_service_type_support_handle__${pkg}__${sub}__${name}`);
}

export function actionTypeSupport(pkg: string, name: string): Pointer {
  return resolve(pkg, `rosidl_typesupport_c__get_action_type_support_handle__${pkg}__action__${name}`);
}
