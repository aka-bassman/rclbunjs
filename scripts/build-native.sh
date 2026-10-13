#!/usr/bin/env bash
# Builds build/librclbunjs_shim.so with the system C compiler (optional: by
# default the shim is compiled at runtime with bun:ffi's TinyCC). Same as
# `bunx rclbunjs-build-shim`; arguments (--out <path>) are passed on.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec bun "$ROOT/bin/rclbunjs-build-shim.ts" "$@"
