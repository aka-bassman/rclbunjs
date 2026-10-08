// Helpers for crossing the bun:ffi boundary.
import { ptr, toArrayBuffer, type Pointer } from "bun:ffi";
import { lib } from "./loader.ts";
import { NativeError } from "../core/errors.ts";

const encoder = new TextEncoder();

/** NUL-terminated UTF-8 copy of `s` (keep the returned buffer alive during the call). */
export function cstr(s: string): Uint8Array {
  const b = encoder.encode(s);
  const out = new Uint8Array(b.length + 1);
  out.set(b);
  return out;
}

/** Throws a NativeError with the shim's last error if pointer `p` is null. */
export function check(p: unknown, what: string): Pointer {
  if (!p) throw new NativeError(`${what}: ${lastError()}`);
  return p as Pointer;
}

/** Throws a NativeError if `rc` is negative. Returns rc. */
export function checkRc<T extends number | bigint>(rc: T, what: string): T {
  if (rc < 0) throw new NativeError(`${what}: ${lastError()}`);
  return rc;
}

export function lastError(): string {
  return String(lib.rb_last_error() ?? "unknown error");
}

/**
 * argv as a C `const char**`. Returns the pointer array plus the buffers that
 * must stay referenced until the native call returns.
 */
export function cstrArray(items: string[]): { argc: number; argv: Pointer | null; keep: unknown[] } {
  if (items.length === 0) return { argc: 0, argv: null, keep: [] };
  const bufs = items.map(cstr);
  const arr = new BigUint64Array(items.length);
  bufs.forEach((b, i) => (arr[i] = BigInt(ptr(b))));
  return { argc: items.length, argv: ptr(arr), keep: [bufs, arr] };
}

/** Copies `len` bytes at native pointer `p` into a fresh Uint8Array. */
export function copyOut(p: Pointer, len: number): Uint8Array {
  return new Uint8Array(toArrayBuffer(p, 0, len)).slice();
}

/** Reads a JSON string returned by the shim, throwing on NULL. */
export function json<T>(s: unknown, what: string): T {
  if (s === null || s === undefined) throw new NativeError(`${what}: ${lastError()}`);
  return JSON.parse(String(s)) as T;
}

export { ptr };
