#!/usr/bin/env bash
# Run integration tests inside the ROS 2 dev container.
#   scripts/docker-test.sh                 -> bun test test/integration
#   scripts/docker-test.sh bun run x.ts    -> arbitrary command
set -euo pipefail
ROS_DISTRO="${ROS_DISTRO:-jazzy}"
IMAGE="rclbunjs-dev:${ROS_DISTRO}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker build -t "$IMAGE" --build-arg ROS_DISTRO="$ROS_DISTRO" "$ROOT/docker"
fi
# RCLBUN_DOCKER_MEMORY=6g: memory limit for the container (docker run --memory, no extra swap)
MEM=()
[ -n "${RCLBUN_DOCKER_MEMORY:-}" ] && MEM=(--memory "$RCLBUN_DOCKER_MEMORY" --memory-swap "$RCLBUN_DOCKER_MEMORY")
# pass RCLBUN_* and SOAK_* settings through to the container
PASS=()
while IFS='=' read -r k _; do PASS+=(-e "$k"); done < <(env | grep -E '^(RCLBUN|SOAK)_[A-Z0-9_]*=' || true)
CMD=("$@")
[ ${#CMD[@]} -eq 0 ] && CMD=(bun test test/integration)
# rmw_zenoh_cpp needs a router; start one in the container
PRE=""
if [ "${RMW_IMPLEMENTATION:-}" = rmw_zenoh_cpp ]; then
  PRE="(/opt/ros/${ROS_DISTRO}/lib/rmw_zenoh_cpp/rmw_zenohd >/tmp/rmw_zenohd.log 2>&1 &) && sleep 1 && "
fi
# RCLBUN_CYCLONE_SHM=1: Cyclone DDS over iceoryx shared memory (RouDi in the container).
# RouDi needs POSIX ACLs on /dev/shm, which Docker Desktop's kernel lacks: use a Linux host.
SHM=()
if [ "${RCLBUN_CYCLONE_SHM:-}" = 1 ]; then
  case "$ROS_DISTRO" in
    humble|jazzy|kilted) CYCLONEDDS_URI='<CycloneDDS><Domain><SharedMemory><Enable>true</Enable></SharedMemory></Domain></CycloneDDS>' ;;
    *) CYCLONEDDS_URI='<CycloneDDS><Domain><General><Interfaces><PubSubMessageExchange type="iox"/></Interfaces></General></Domain></CycloneDDS>' ;;
  esac
  SHM=(--shm-size=1g -e CYCLONEDDS_URI="$CYCLONEDDS_URI")
  RMW_IMPLEMENTATION="${RMW_IMPLEMENTATION:-rmw_cyclonedds_cpp}"
  PRE="(iox-roudi >/tmp/roudi.log 2>&1 &) && sleep 1 && "
fi
exec docker run --rm --network none ${MEM[@]+"${MEM[@]}"} ${SHM[@]+"${SHM[@]}"} \
  -e ROS_DOMAIN_ID="$((RANDOM % 100 + 1))" ${PASS[@]+"${PASS[@]}"} \
  ${RMW_IMPLEMENTATION:+-e RMW_IMPLEMENTATION="$RMW_IMPLEMENTATION"} \
  -v "$ROOT:/app" -w /app "$IMAGE" \
  bash -c "source /opt/ros/${ROS_DISTRO}/setup.bash && ${PRE}$(printf '%q ' "${CMD[@]}")"
