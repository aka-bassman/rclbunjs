# Dev/test image: ROS 2 + Bun + interfaces used by the test-suite.
ARG ROS_DISTRO=jazzy
ARG BUN_VERSION=1.4.2
FROM oven/bun:${BUN_VERSION}-slim AS bun
FROM ros:${ROS_DISTRO}-ros-base
ARG ROS_DISTRO
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN apt-get update && apt-get install -y --no-install-recommends \
      ros-${ROS_DISTRO}-test-msgs ros-${ROS_DISTRO}-example-interfaces ros-${ROS_DISTRO}-rmw-cyclonedds-cpp \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
