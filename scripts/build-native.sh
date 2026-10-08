#!/usr/bin/env bash
# Builds build/librclbunjs_shim.so with the system C compiler (optional: by
# default the shim is compiled at runtime with bun:ffi's TinyCC).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ROS_PREFIX="${ROS_PREFIX:-/opt/ros/${ROS_DISTRO:?source your ROS 2 setup first}}"
# root include dir + nested package dirs only (flat dirs would shadow system headers)
INC=("-I$ROS_PREFIX/include")
for d in "$ROS_PREFIX"/include/*; do [ -d "$d/$(basename "$d")" ] && INC+=("-I$d"); done
mkdir -p "$ROOT/build"
DISTRO_DEF="-DRB_DISTRO_$(echo "${ROS_DISTRO:-}" | tr '[:lower:]' '[:upper:]')"
${CC:-cc} -O2 -fPIC -shared "$DISTRO_DEF" -Wall -Wno-unused-function -o "$ROOT/build/librclbunjs_shim.so" "$ROOT/src/native/shim.c" \
  "${INC[@]}" -L"$ROS_PREFIX/lib" -Wl,-rpath,"$ROS_PREFIX/lib" \
  -lrcl -lrcutils -lrmw -lrmw_implementation -lrcl_yaml_param_parser -lrosidl_runtime_c -lpthread
echo "built $ROOT/build/librclbunjs_shim.so"
