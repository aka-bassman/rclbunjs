#!/usr/bin/env bash
# Runs the integration suite for several distro / RMW / shim combinations, one after another.
#   scripts/test-matrix.sh jazzy - cc  jazzy rmw_zenoh_cpp cc  lyrical - prebuilt
# Each combination is "<distro> <rmw or -> <cc|prebuilt>"; logs go to $MATRIX_LOGS (default /tmp/rclbunjs-matrix).
# prebuilt builds the shim with scripts/build-native.sh inside the container and removes it afterwards
# (the container runs as root), so don't run a prebuilt combination next to another run on the same checkout.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="${MATRIX_LOGS:-/tmp/rclbunjs-matrix}"
mkdir -p "$LOG"
while [ $# -ge 3 ]; do
  d=$1 rmw=$2 mode=$3
  shift 3
  envs=(ROS_DISTRO="$d")
  if [ "$rmw" = - ]; then
    name="$d-default-$mode"
  else
    name="$d-${rmw#rmw_}-$mode"
    envs+=(RMW_IMPLEMENTATION="$rmw")
  fi
  if [ "$mode" = prebuilt ]; then
    env "${envs[@]}" "$ROOT/scripts/docker-test.sh" bash -c \
      'scripts/build-native.sh && bun test test/integration; rc=$?; rm -rf build; exit $rc' >"$LOG/$name.log" 2>&1
  else
    env "${envs[@]}" "$ROOT/scripts/docker-test.sh" >"$LOG/$name.log" 2>&1
  fi
  rc=$?
  echo "$name exit=$rc $(grep -E '^ *[0-9]+ (pass|fail|skip)' "$LOG/$name.log" | tr -s ' ' | tr '\n' ' ')"
done
