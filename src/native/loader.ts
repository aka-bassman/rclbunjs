// Loads the native shim: a prebuilt shared library if present (see
// scripts/build-native.sh), otherwise compiles src/native/shim.c at runtime
// with bun:ffi's built-in TinyCC against the sourced ROS 2 installation.
import { cc, dlopen, FFIType, type Pointer } from "bun:ffi";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const P = FFIType.ptr;
const I32 = FFIType.i32;
const I64 = FFIType.i64;
const U64 = FFIType.u64;
const CSTR = FFIType.cstring;
const VOID = FFIType.void;

export const symbols = {
  rb_last_error: { returns: CSTR, args: [] },
  rb_free: { returns: VOID, args: [P] },
  rb_rmw_implementation: { returns: CSTR, args: [] },
  rb_serialization_format: { returns: CSTR, args: [] },

  rb_context_init: { returns: P, args: [I32, P, I64] },
  rb_context_is_valid: { returns: I32, args: [P] },
  rb_context_shutdown: { returns: I32, args: [P] },
  rb_context_fini: { returns: I32, args: [P] },
  rb_context_domain_id: { returns: I64, args: [P] },
  rb_context_unparsed_args: { returns: CSTR, args: [P, I32, P] },

  rb_validate_node_name: { returns: CSTR, args: [P] },
  rb_validate_namespace: { returns: CSTR, args: [P] },
  rb_validate_topic_name: { returns: CSTR, args: [P] },
  rb_validate_full_topic_name: { returns: CSTR, args: [P] },

  rb_node_init: { returns: P, args: [P, P, P, I32, I32, P, I32, P] },
  rb_node_fini: { returns: I32, args: [P] },
  rb_node_name: { returns: CSTR, args: [P] },
  rb_node_namespace: { returns: CSTR, args: [P] },
  rb_node_fqn: { returns: CSTR, args: [P] },
  rb_node_logger_name: { returns: CSTR, args: [P] },
  rb_node_resolve_name: { returns: CSTR, args: [P, P, I32, I32] },
  rb_node_param_overrides: { returns: CSTR, args: [P, P] },

  rb_log: { returns: I32, args: [P, I32, P, P, I64, P] },
  rb_logging_set_level: { returns: I32, args: [P, I32] },
  rb_logging_get_effective_level: { returns: I32, args: [P] },
  rb_logging_get_level: { returns: I32, args: [P] },
  rb_logging_configure: { returns: I32, args: [P] },
  rb_logging_fini: { returns: I32, args: [] },
  rb_logging_add_sublogger: { returns: I32, args: [P, P] },
  rb_logging_remove_sublogger: { returns: VOID, args: [P, P] },
  rb_logging_is_enabled_for: { returns: I32, args: [P, I32] },

  rb_pub_init: { returns: P, args: [P, P, P, P] },
  rb_pub_fini: { returns: I32, args: [P] },
  rb_pub_publish: { returns: I32, args: [P, P, U64] },
  rb_pub_topic: { returns: CSTR, args: [P] },
  rb_pub_subscription_count: { returns: I64, args: [P] },
  rb_pub_assert_liveliness: { returns: I32, args: [P] },
  rb_pub_wait_for_all_acked: { returns: I32, args: [P, I64] },
  rb_pub_qos: { returns: CSTR, args: [P] },

  rb_sub_init: { returns: P, args: [P, P, P, P, P, I32, P] },
  rb_sub_set_content_filter: { returns: I32, args: [P, P, I32, P] },
  rb_sub_is_cft_enabled: { returns: I32, args: [P] },
  rb_sub_get_content_filter: { returns: CSTR, args: [P] },
  rb_event_init: { returns: P, args: [P, I32, I32] },
  rb_event_fini: { returns: I32, args: [P] },
  rb_event_take: { returns: CSTR, args: [P] },
  rb_sub_fini: { returns: I32, args: [P] },
  rb_sub_take: { returns: I64, args: [P, P] },
  rb_sub_last_info: { returns: VOID, args: [P, P] },
  rb_sub_topic: { returns: CSTR, args: [P] },
  rb_sub_publisher_count: { returns: I64, args: [P] },
  rb_sub_qos: { returns: CSTR, args: [P] },

  rb_cmsg_new: { returns: P, args: [P] },
  rb_cmsg_free: { returns: VOID, args: [P] },
  rb_cmsg_load: { returns: I32, args: [P, P, U64] },
  rb_cmsg_dump: { returns: I64, args: [P, P] },
  rb_cmsg_ptr: { returns: P, args: [P] },

  rb_client_init: { returns: P, args: [P, P, P, P, P, P] },
  rb_client_fini: { returns: I32, args: [P] },
  rb_client_send: { returns: I64, args: [P, P, U64] },
  rb_client_take: { returns: I64, args: [P, P, P] },
  rb_client_server_available: { returns: I32, args: [P] },
  rb_client_service_name: { returns: CSTR, args: [P] },

  rb_service_init: { returns: P, args: [P, P, P, P, P, P] },
  rb_service_fini: { returns: I32, args: [P] },
  rb_service_take: { returns: I64, args: [P, P, P] },
  rb_service_send: { returns: I32, args: [P, P, P, U64] },
  rb_service_name: { returns: CSTR, args: [P] },
  rb_service_configure_introspection: { returns: I32, args: [P, P, P, P, I32] },
  rb_client_configure_introspection: { returns: I32, args: [P, P, P, P, I32] },
  rb_type_description_service_init: { returns: P, args: [P, P, P] },
  rb_type_description_service_handle: { returns: I32, args: [P] },
  rb_message_type_hash: { returns: CSTR, args: [P] },
  rb_features: { returns: I32, args: [] },

  rb_clock_init: { returns: P, args: [I32] },
  rb_clock_fini: { returns: I32, args: [P] },
  rb_clock_now: { returns: I64, args: [P] },
  rb_clock_type: { returns: I32, args: [P] },
  rb_clock_enable_ros_time_override: { returns: I32, args: [P, I32] },
  rb_clock_set_ros_time_override: { returns: I32, args: [P, I64] },
  rb_set_jump_handler: { returns: VOID, args: [FFIType.function] },
  rb_clock_add_jump_callback: { returns: I32, args: [P, I32, I32, I64, I64] },
  rb_clock_remove_jump_callback: { returns: I32, args: [P, I32] },
  rb_clock_ros_time_override_enabled: { returns: I32, args: [P] },

  rb_timer_init: { returns: P, args: [P, P, I64, I32] },
  rb_timer_fini: { returns: I32, args: [P] },
  rb_timer_call: { returns: I32, args: [P, P] },
  rb_timer_cancel: { returns: I32, args: [P] },
  rb_timer_reset: { returns: I32, args: [P] },
  rb_timer_is_canceled: { returns: I32, args: [P] },
  rb_timer_period: { returns: I64, args: [P] },
  rb_timer_change_period: { returns: I64, args: [P, I64] },
  rb_timer_time_until_next_call: { returns: I64, args: [P] },
  rb_timer_time_since_last_call: { returns: I64, args: [P] },

  rb_guard_init: { returns: P, args: [P] },
  rb_guard_fini: { returns: I32, args: [P] },
  rb_guard_trigger: { returns: I32, args: [P] },

  rb_exec_create: { returns: P, args: [P, FFIType.function] },
  rb_exec_arm: { returns: I32, args: [P, P, I64] },
  rb_exec_ready_ptr: { returns: P, args: [P] },
  rb_exec_ready_cap: { returns: I64, args: [P] },
  rb_exec_interrupt: { returns: VOID, args: [P] },
  rb_exec_interrupt_sync: { returns: I32, args: [P] },
  rb_exec_destroy: { returns: VOID, args: [P] },
  rb_wait_sync: { returns: I32, args: [P, P, I64, P] },

  rb_graph_names_and_types: { returns: CSTR, args: [P, I32, P, P, I32] },
  rb_graph_node_names: { returns: CSTR, args: [P, I32] },
  rb_graph_count: { returns: I64, args: [P, I32, P] },
  rb_graph_endpoint_info: { returns: CSTR, args: [P, I32, P, I32] },
} as const;

const LIBS = [
  "rcl",
  "rcutils",
  "rmw",
  "rmw_implementation",
  "rcl_yaml_param_parser",
  "rosidl_runtime_c",
  "rosidl_typesupport_introspection_c",
];

/** Finds the ROS 2 install prefix that provides rcl (from AMENT_PREFIX_PATH). */
export function rosRoot(): string {
  const prefixes = (process.env.AMENT_PREFIX_PATH ?? "").split(":").filter(Boolean);
  for (const p of prefixes) {
    if (existsSync(join(p, "include", "rcl", "rcl", "rcl.h"))) return p;
  }
  const distro = process.env.ROS_DISTRO;
  if (distro && existsSync(`/opt/ros/${distro}/include/rcl`)) return `/opt/ros/${distro}`;
  throw new Error(
    "rclbunjs: could not find a ROS 2 installation. Source it first, e.g. `source /opt/ros/jazzy/setup.bash`.",
  );
}

function loadNative() {
  const prebuilt = process.env.RCLBUN_SHIM ?? join(import.meta.dir, "..", "..", "build", "librclbunjs_shim.so");
  if (existsSync(prebuilt) && process.env.RCLBUN_FORCE_CC !== "1") {
    return dlopen(prebuilt, symbols);
  }
  const root = rosRoot();
  const includeRoot = join(root, "include");
  // Only nested package dirs (include/<pkg>/<pkg>/...). Adding flat-layout dirs
  // (e.g. Humble's include/rcutils/time.h) would shadow system headers.
  const include = [
    includeRoot,
    ...readdirSync(includeRoot)
      .filter((d) => existsSync(join(includeRoot, d, d)))
      .map((d) => join(includeRoot, d)),
  ];
  const distro = (process.env.ROS_DISTRO ?? "").toUpperCase().replace(/[^A-Z0-9_]/g, "");
  return cc({
    source: join(import.meta.dir, "shim.c"),
    include,
    library: LIBS,
    flags: [`-L${join(root, "lib")}`],
    define: distro ? { [`RB_DISTRO_${distro}`]: "1" } : {},
    symbols,
  });
}

const native = loadNative();
export const lib = native.symbols;
export type NativeLib = typeof lib;

/** Optional rcl features compiled into the shim (see rb_features in shim.c). */
const featureBits = lib.rb_features();
export const features = {
  timerCallInfo: (featureBits & 1) !== 0,
  serviceIntrospection: (featureBits & 2) !== 0,
  typeDescriptionService: (featureBits & 4) !== 0,
  matchedEvents: (featureBits & 8) !== 0,
  loggerService: (featureBits & 16) !== 0,
  rosoutSubloggers: (featureBits & 32) !== 0,
};
export type { Pointer };
