// ROS distro and RMW helpers (rclnodejs lib/distro.js, lib/rmw.js).

export const DistroId = {
  UNKNOWN: 0,
  ELOQUENT: 1911,
  FOXY: 2006,
  GALACTIC: 2105,
  HUMBLE: 2205,
  IRON: 2305,
  JAZZY: 2405,
  KILTED: 2505,
  LYRICAL: 2605,
  ROLLING: 5000,
  /** an unrecognized ROS_DISTRO is assumed to be newer than Rolling */
  FUTURE: 9999,
} as const;

const distroIds = new Map<string, number>([
  ["eloquent", DistroId.ELOQUENT],
  ["foxy", DistroId.FOXY],
  ["galactic", DistroId.GALACTIC],
  ["humble", DistroId.HUMBLE],
  ["iron", DistroId.IRON],
  ["jazzy", DistroId.JAZZY],
  ["kilted", DistroId.KILTED],
  ["lyrical", DistroId.LYRICAL],
  ["rolling", DistroId.ROLLING],
]);

export const DistroUtils = {
  DistroId,

  getDistroId(distroName?: string): number {
    const name = (distroName || this.getDistroName() || "").toLowerCase();
    if (!name) return DistroId.UNKNOWN;
    return distroIds.get(name) ?? DistroId.FUTURE;
  },

  /** Name for a distro id, or $ROS_DISTRO when no id is given. */
  getDistroName(distroId?: number): string | undefined {
    if (!distroId) return process.env.ROS_DISTRO;
    return [...distroIds].find(([, id]) => id === distroId)?.[0];
  },

  getKnownDistroNames(): string[] {
    return [...distroIds.keys()];
  },
};

export const RMWNames = {
  FASTRTPS: "rmw_fastrtps_cpp",
  CONNEXT: "rmw_connext_cpp",
  CYCLONEDDS: "rmw_cyclonedds_cpp",
  GURUMDDS: "rmw_gurumdds_cpp",
  ZENOH: "rmw_zenoh_cpp",
} as const;

export const RMWUtils = {
  RMWNames,

  /** $RMW_IMPLEMENTATION, or the distro's default RMW. */
  getRMWName(): string {
    if (process.env.RMW_IMPLEMENTATION) return process.env.RMW_IMPLEMENTATION;
    return DistroUtils.getDistroName() === "galactic" ? RMWNames.CYCLONEDDS : RMWNames.FASTRTPS;
  },
};
