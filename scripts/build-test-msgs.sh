#!/usr/bin/env bash
# Builds test/fixtures/rclbun_test_msgs (test-only interfaces) into ${OUT:-/tmp/rclbun_test_msgs}.
# Run inside the dev container, then: source "$OUT/install/setup.bash"
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${OUT:-/tmp/rclbun_test_msgs}"
colcon --log-base "$OUT/log" build --base-paths "$ROOT/test/fixtures/rclbun_test_msgs" \
  --build-base "$OUT/build" --install-base "$OUT/install" --event-handlers console_cohesion- >/dev/null
echo "built $OUT/install"
