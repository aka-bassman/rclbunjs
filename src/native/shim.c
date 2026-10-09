// rclbunjs native shim: a thin, pointer-only C layer over rcl for bun:ffi.
//
// Rules for everything exported here:
//   - only pointers, integers and C strings cross the boundary (bun:ffi cannot
//     pass/return structs by value);
//   - failures return NULL / a negative value and leave a message that JS reads
//     with rb_last_error();
//   - composite results are returned as JSON strings owned by the shim and valid
//     until the next call that returns JSON on the same thread.
//
// Distro differences are selected with RB_DISTRO_<NAME> (defined by the loader
// from $ROS_DISTRO): Humble lacks rcl_timer_init2 and the matched /
// incompatible-type QoS events. APIs newer than Kilted are selected by rcl
// version instead, since Rolling moves ahead of the latest release.

#include <pthread.h>
#include <semaphore.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include <rcl/rcl.h>
#include <rcl/error_handling.h>
#include <rcl/event.h>
#include <rcl/graph.h>
#include <rcl/logging.h>
#include <rcl/logging_rosout.h>
#include <rcl/remap.h>
#include <rcl/time.h>
#include <rcl/validate_topic_name.h>
#include <rcl/version.h>
#include <rcl_yaml_param_parser/parser.h>
#include <rcutils/logging.h>
#include <rmw/rmw.h>
#include <rmw/serialized_message.h>
#include <rmw/validate_full_topic_name.h>
#include <rmw/validate_namespace.h>
#include <rmw/validate_node_name.h>
#include <rosidl_runtime_c/message_type_support_struct.h>
#include <rosidl_typesupport_introspection_c/field_types.h>
#include <rosidl_typesupport_introspection_c/identifier.h>
#include <rosidl_typesupport_introspection_c/message_introspection.h>

#define RB_RCL_AT_LEAST(major, minor) \
  (RCL_VERSION_MAJOR > (major) || (RCL_VERSION_MAJOR == (major) && RCL_VERSION_MINOR >= (minor)))
// Lyrical (rcl 10.4): service endpoint info, action client/server counts.
// Rolling (rcl 10.5): action endpoint info.
#define RB_HAS_SERVICE_ENDPOINT_INFO RB_RCL_AT_LEAST(10, 4)
#define RB_HAS_ACTION_ENDPOINT_INFO RB_RCL_AT_LEAST(10, 5)
#if RB_HAS_SERVICE_ENDPOINT_INFO
#include <rcl_action/graph.h>
#endif

// ---------------------------------------------------------------------------
// errors

static char g_err[2048];

static void rb_set_error(const char* fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(g_err, sizeof(g_err), fmt, ap);
  va_end(ap);
}

// Captures the current rcl error (if any) with a prefix and resets it.
static void rb_take_rcl_error(const char* what, rcl_ret_t ret) {
  if (rcl_error_is_set()) {
    rb_set_error("%s failed (rc=%d): %s", what, (int)ret, rcl_get_error_string().str);
    rcl_reset_error();
  } else {
    rb_set_error("%s failed (rc=%d)", what, (int)ret);
  }
}

const char* rb_last_error(void) { return g_err; }

// ---------------------------------------------------------------------------
// tiny JSON builder (for composite results)

typedef struct {
  char* buf;
  size_t len, cap;
} rb_json_t;

static rb_json_t g_json;

static void js_reset(void) {
  g_json.len = 0;
  if (!g_json.buf) {
    g_json.cap = 4096;
    g_json.buf = malloc(g_json.cap);
  }
  g_json.buf[0] = 0;
}

static void js_raw(const char* s, size_t n) {
  if (g_json.len + n + 1 > g_json.cap) {
    while (g_json.len + n + 1 > g_json.cap) g_json.cap *= 2;
    g_json.buf = realloc(g_json.buf, g_json.cap);
  }
  memcpy(g_json.buf + g_json.len, s, n);
  g_json.len += n;
  g_json.buf[g_json.len] = 0;
}

static void js_lit(const char* s) { js_raw(s, strlen(s)); }

static void js_str(const char* s) {
  js_raw("\"", 1);
  if (s) {
    for (const char* p = s; *p; p++) {
      unsigned char c = (unsigned char)*p;
      if (c == '"' || c == '\\') {
        char e[2] = {'\\', (char)c};
        js_raw(e, 2);
      } else if (c < 0x20) {
        char e[8];
        snprintf(e, sizeof(e), "\\u%04x", c);
        js_raw(e, 6);
      } else {
        js_raw((const char*)&c, 1);
      }
    }
  }
  js_raw("\"", 1);
}

static void js_int(int64_t v) {
  char b[32];
  int n = snprintf(b, sizeof(b), "%lld", (long long)v);
  js_raw(b, (size_t)n);
}

// ---------------------------------------------------------------------------
// QoS: JS passes int64_t[9]
//   [history, depth, reliability, durability, deadline_ns, lifespan_ns,
//    liveliness, liveliness_lease_ns, avoid_ros_namespace_conventions]
// A NULL pointer means "rmw default profile".

static rmw_time_t rb_ns_to_rmw_time(int64_t ns) {
  rmw_time_t t;
  if (ns < 0) {
    t.sec = 9223372036LL;
    t.nsec = 854775807LL;  // RMW_DURATION_INFINITE
  } else {
    t.sec = (uint64_t)(ns / 1000000000LL);
    t.nsec = (uint64_t)(ns % 1000000000LL);
  }
  return t;
}

static int64_t rb_rmw_time_to_ns(rmw_time_t t) {
  if (t.sec >= 9223372036ULL) return -1;
  return (int64_t)t.sec * 1000000000LL + (int64_t)t.nsec;
}

static void rb_apply_qos(rmw_qos_profile_t* q, const int64_t* a) {
  if (!a) return;
  q->history = (enum rmw_qos_history_policy_e)a[0];
  q->depth = (size_t)a[1];
  q->reliability = (enum rmw_qos_reliability_policy_e)a[2];
  q->durability = (enum rmw_qos_durability_policy_e)a[3];
  q->deadline = rb_ns_to_rmw_time(a[4]);
  q->lifespan = rb_ns_to_rmw_time(a[5]);
  q->liveliness = (enum rmw_qos_liveliness_policy_e)a[6];
  q->liveliness_lease_duration = rb_ns_to_rmw_time(a[7]);
  q->avoid_ros_namespace_conventions = a[8] != 0;
}

static void js_qos(const rmw_qos_profile_t* q) {
  js_lit("{\"history\":");
  js_int(q->history);
  js_lit(",\"depth\":");
  js_int((int64_t)q->depth);
  js_lit(",\"reliability\":");
  js_int(q->reliability);
  js_lit(",\"durability\":");
  js_int(q->durability);
  js_lit(",\"deadline\":");
  js_int(rb_rmw_time_to_ns(q->deadline));
  js_lit(",\"lifespan\":");
  js_int(rb_rmw_time_to_ns(q->lifespan));
  js_lit(",\"liveliness\":");
  js_int(q->liveliness);
  js_lit(",\"livelinessLeaseDuration\":");
  js_int(rb_rmw_time_to_ns(q->liveliness_lease_duration));
  js_lit(",\"avoidRosNamespaceConventions\":");
  js_lit(q->avoid_ros_namespace_conventions ? "true" : "false");
  js_lit("}");
}

// ---------------------------------------------------------------------------
// context

static int g_logging_configured = 0;

// Configures rcl logging (console, /rosout, log file) from a context's
// arguments once per process; later calls are no-ops.
int rb_logging_configure(void* ctx) {
  if (g_logging_configured) return 0;
  rcl_allocator_t alloc = rcl_get_default_allocator();
  rcl_ret_t ret = rcl_logging_configure(&((rcl_context_t*)ctx)->global_arguments, &alloc);
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("rcl_logging_configure", ret);
    return -1;
  }
  g_logging_configured = 1;
  return 0;
}

int rb_logging_fini(void) {
  if (!g_logging_configured) return 0;
  g_logging_configured = 0;
  rcl_ret_t ret = rcl_logging_fini();
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("rcl_logging_fini", ret);
    return -1;
  }
  return 0;
}

void* rb_context_init(int argc, const char** argv, int64_t domain_id) {
  rcl_allocator_t alloc = rcl_get_default_allocator();
  rcl_init_options_t opts = rcl_get_zero_initialized_init_options();
  rcl_ret_t ret = rcl_init_options_init(&opts, alloc);
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("rcl_init_options_init", ret);
    return NULL;
  }
  if (domain_id >= 0) rcl_init_options_set_domain_id(&opts, (size_t)domain_id);
  rcl_context_t* ctx = malloc(sizeof(*ctx));
  *ctx = rcl_get_zero_initialized_context();
  ret = rcl_init(argc, argv, &opts, ctx);
  rcl_init_options_fini(&opts);
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("rcl_init", ret);
    free(ctx);
    return NULL;
  }
  if (rb_logging_configure(ctx) != 0) rcl_reset_error();
  return ctx;
}

int rb_context_is_valid(void* ctx) { return rcl_context_is_valid((rcl_context_t*)ctx) ? 1 : 0; }

int rb_context_shutdown(void* ctx) {
  rcl_context_t* c = ctx;
  if (!rcl_context_is_valid(c)) return 0;
  rcl_ret_t ret = rcl_shutdown(c);
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("rcl_shutdown", ret);
    return -1;
  }
  return 0;
}

int rb_context_fini(void* ctx) {
  rcl_context_t* c = ctx;
  rcl_ret_t ret = rcl_context_fini(c);
  free(c);
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("rcl_context_fini", ret);
    return -1;
  }
  return 0;
}

int64_t rb_context_domain_id(void* ctx) {
  size_t id = 0;
  if (rcl_context_get_domain_id((rcl_context_t*)ctx, &id) != RCL_RET_OK) {
    rcl_reset_error();
    return -1;
  }
  return (int64_t)id;
}

// JSON array of arguments rcl did not recognise as ROS arguments.
const char* rb_context_unparsed_args(void* ctx, int argc, const char** argv) {
  rcl_context_t* c = ctx;
  rcl_allocator_t alloc = rcl_get_default_allocator();
  int* idx = NULL;
  int n = rcl_arguments_get_count_unparsed(&c->global_arguments);
  js_reset();
  js_lit("[");
  if (n > 0 && rcl_arguments_get_unparsed(&c->global_arguments, alloc, &idx) == RCL_RET_OK) {
    for (int i = 0; i < n; i++) {
      if (i) js_lit(",");
      js_str(idx[i] < argc ? argv[idx[i]] : "");
    }
    alloc.deallocate(idx, alloc.state);
  }
  js_lit("]");
  return g_json.buf;
}

// ---------------------------------------------------------------------------
// names

const char* rb_validate_node_name(const char* name) {
  int result = 0;
  size_t index = 0;
  if (rmw_validate_node_name(name, &result, &index) != RMW_RET_OK) return "validation error";
  if (result == RMW_NODE_NAME_VALID) return NULL;
  rb_set_error("%s (at %zu)", rmw_node_name_validation_result_string(result), index);
  return g_err;
}

const char* rb_validate_namespace(const char* ns) {
  int result = 0;
  size_t index = 0;
  if (rmw_validate_namespace(ns, &result, &index) != RMW_RET_OK) return "validation error";
  if (result == RMW_NAMESPACE_VALID) return NULL;
  rb_set_error("%s (at %zu)", rmw_namespace_validation_result_string(result), index);
  return g_err;
}

const char* rb_validate_topic_name(const char* name) {
  int result = 0;
  size_t index = 0;
  if (rcl_validate_topic_name(name, &result, &index) != RCL_RET_OK) {
    rcl_reset_error();
    return "validation error";
  }
  if (result == RCL_TOPIC_NAME_VALID) return NULL;
  rb_set_error("%s (at %zu)", rcl_topic_name_validation_result_string(result), index);
  return g_err;
}

const char* rb_validate_full_topic_name(const char* name) {
  int result = 0;
  size_t index = 0;
  if (rmw_validate_full_topic_name(name, &result, &index) != RMW_RET_OK) return "validation error";
  if (result == RMW_TOPIC_VALID) return NULL;
  rb_set_error("%s (at %zu)", rmw_full_topic_name_validation_result_string(result), index);
  return g_err;
}

// ---------------------------------------------------------------------------
// node

// rosout_qos: packed QoS (see rb_apply_qos) or NULL for the rcl default.
void* rb_node_init(void* ctx, const char* name, const char* ns, int use_global_args,
                   int enable_rosout, const int64_t* rosout_qos, int argc, const char** argv) {
  rcl_node_t* n = malloc(sizeof(*n));
  *n = rcl_get_zero_initialized_node();
  rcl_node_options_t o = rcl_node_get_default_options();
  o.use_global_arguments = use_global_args != 0;
  o.enable_rosout = enable_rosout != 0;
  if (rosout_qos) rb_apply_qos(&o.rosout_qos, rosout_qos);
  if (argc > 0) {
    rcl_ret_t pr = rcl_parse_arguments(argc, argv, o.allocator, &o.arguments);
    if (pr != RCL_RET_OK) {
      rb_take_rcl_error("rcl_parse_arguments", pr);
      free(n);
      return NULL;
    }
  }
  rcl_ret_t ret = rcl_node_init(n, name, ns, (rcl_context_t*)ctx, &o);
  rcl_node_options_fini(&o);
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("rcl_node_init", ret);
    free(n);
    return NULL;
  }
#if !defined(RB_DISTRO_HUMBLE)
  // Since Iron the client library creates the node's /rosout publisher (rclcpp
  // does this in NodeBase); Humble's rcl_node_init still does it itself.
  if (enable_rosout && rcl_logging_rosout_enabled()) {
    ret = rcl_logging_rosout_init_publisher_for_node(n);
    if (ret != RCL_RET_OK) {
      rb_take_rcl_error("rcl_logging_rosout_init_publisher_for_node", ret);
      rcl_node_fini(n);
      free(n);
      return NULL;
    }
  }
#endif
  return n;
}

int rb_node_fini(void* node) {
#if !defined(RB_DISTRO_HUMBLE)
  if (rcl_logging_rosout_enabled() && rcl_node_get_options((rcl_node_t*)node)->enable_rosout) {
    if (rcl_logging_rosout_fini_publisher_for_node((rcl_node_t*)node) != RCL_RET_OK) rcl_reset_error();
  }
#endif
  rcl_ret_t ret = rcl_node_fini((rcl_node_t*)node);
  free(node);
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("rcl_node_fini", ret);
    return -1;
  }
  return 0;
}

const char* rb_node_name(void* node) { return rcl_node_get_name((rcl_node_t*)node); }
const char* rb_node_namespace(void* node) { return rcl_node_get_namespace((rcl_node_t*)node); }
const char* rb_node_fqn(void* node) { return rcl_node_get_fully_qualified_name((rcl_node_t*)node); }
const char* rb_node_logger_name(void* node) { return rcl_node_get_logger_name((rcl_node_t*)node); }

// Resolves (expands + remaps) a topic or service name the way rcl would.
const char* rb_node_resolve_name(void* node, const char* name, int is_service, int only_expand) {
  rcl_allocator_t alloc = rcl_get_default_allocator();
  char* out = NULL;
  rcl_ret_t ret = rcl_node_resolve_name((rcl_node_t*)node, name, alloc, is_service != 0,
                                        only_expand != 0, &out);
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("rcl_node_resolve_name", ret);
    return NULL;
  }
  js_reset();
  js_lit(out);
  alloc.deallocate(out, alloc.state);
  return g_json.buf;
}

// JSON object of parameter overrides, keyed by the node name pattern from the
// arguments / YAML files ("/**", "/ns/node", ...):
//   { "<pattern>": { "param": {"type": "...", "value": ...}, ... }, ...,
//     "__node_local__": { ...same shape, from the node's own arguments... } }
// Integers are emitted as strings to keep 64-bit precision in JS.
static void js_param_value(const rcl_variant_t* v) {
  char b[64];
  if (v->bool_value) {
    js_lit("{\"type\":\"bool\",\"value\":");
    js_lit(*v->bool_value ? "true" : "false");
  } else if (v->integer_value) {
    js_lit("{\"type\":\"integer\",\"value\":\"");
    js_int(*v->integer_value);
    js_lit("\"");
  } else if (v->double_value) {
    snprintf(b, sizeof(b), "%.17g", *v->double_value);
    js_lit("{\"type\":\"double\",\"value\":");
    js_lit(b);
  } else if (v->string_value) {
    js_lit("{\"type\":\"string\",\"value\":");
    js_str(v->string_value);
  } else if (v->bool_array_value) {
    js_lit("{\"type\":\"bool_array\",\"value\":[");
    for (size_t k = 0; k < v->bool_array_value->size; k++) {
      if (k) js_lit(",");
      js_lit(v->bool_array_value->values[k] ? "true" : "false");
    }
    js_lit("]");
  } else if (v->integer_array_value) {
    js_lit("{\"type\":\"integer_array\",\"value\":[");
    for (size_t k = 0; k < v->integer_array_value->size; k++) {
      if (k) js_lit(",");
      js_lit("\"");
      js_int(v->integer_array_value->values[k]);
      js_lit("\"");
    }
    js_lit("]");
  } else if (v->double_array_value) {
    js_lit("{\"type\":\"double_array\",\"value\":[");
    for (size_t k = 0; k < v->double_array_value->size; k++) {
      if (k) js_lit(",");
      snprintf(b, sizeof(b), "%.17g", v->double_array_value->values[k]);
      js_lit(b);
    }
    js_lit("]");
  } else if (v->string_array_value) {
    js_lit("{\"type\":\"string_array\",\"value\":[");
    for (size_t k = 0; k < v->string_array_value->size; k++) {
      if (k) js_lit(",");
      js_str(v->string_array_value->data[k]);
    }
    js_lit("]");
  } else if (v->byte_array_value) {
    js_lit("{\"type\":\"byte_array\",\"value\":[");
    for (size_t k = 0; k < v->byte_array_value->size; k++) {
      if (k) js_lit(",");
      js_int(v->byte_array_value->values[k]);
    }
    js_lit("]");
  } else {
    js_lit("{\"type\":\"not_set\",\"value\":null");
  }
  js_lit("}");
}

// Writes `"pattern":{...},...` entries; returns the number written.
static size_t js_params(const rcl_params_t* params, size_t already) {
  for (size_t i = 0; i < params->num_nodes; i++) {
    if (already + i) js_lit(",");
    js_str(params->node_names[i]);
    js_lit(":{");
    const rcl_node_params_t* np = &params->params[i];
    for (size_t j = 0; j < np->num_params; j++) {
      if (j) js_lit(",");
      js_str(np->parameter_names[j]);
      js_lit(":");
      js_param_value(&np->parameter_values[j]);
    }
    js_lit("}");
  }
  return already + params->num_nodes;
}

const char* rb_node_param_overrides(void* ctx, void* node) {
  rcl_context_t* c = ctx;
  rcl_node_t* n = node;
  size_t count = 0;
  js_reset();
  js_lit("{");
  rcl_params_t* params = NULL;
  if (rcl_arguments_get_param_overrides(&c->global_arguments, &params) == RCL_RET_OK && params) {
    count = js_params(params, count);
    rcl_yaml_node_struct_fini(params);
  }
  rcl_reset_error();
  params = NULL;
  const rcl_node_options_t* o = rcl_node_get_options(n);
  if (o && rcl_arguments_get_param_overrides(&o->arguments, &params) == RCL_RET_OK && params) {
    if (count) js_lit(",");
    js_lit("\"__node_local__\":{");
    js_params(params, 0);
    js_lit("}");
    rcl_yaml_node_struct_fini(params);
  }
  rcl_reset_error();
  js_lit("}");
  return g_json.buf;
}

// ---------------------------------------------------------------------------
// logging

int rb_log(const char* name, int severity, const char* file, const char* func, int64_t line,
           const char* msg) {
  if (!rcutils_logging_logger_is_enabled_for(name, severity)) return 0;
  rcutils_log_location_t loc = {func, file, (size_t)line};
  rcutils_log(&loc, severity, name, "%s", msg);
  return 1;
}

int rb_logging_set_level(const char* name, int level) {
  rcutils_ret_t ret = rcutils_logging_set_logger_level(name, level);
  if (ret != RCUTILS_RET_OK) {
    rb_take_rcl_error("rcutils_logging_set_logger_level", ret);
    return -1;
  }
  return 0;
}

// Child loggers of a node logger publish to /rosout once registered as
// subloggers (Iron+). Returns 1 if registered, 0 if not applicable.
int rb_logging_add_sublogger(const char* parent, const char* sub) {
#if defined(RB_DISTRO_HUMBLE)
  (void)parent, (void)sub;
  return 0;
#else
  if (!rcl_logging_rosout_enabled()) return 0;
  rcl_ret_t ret = rcl_logging_rosout_add_sublogger(parent, sub);
  if (ret != RCL_RET_OK) {
    rcl_reset_error();  // e.g. the parent is not a node logger
    return 0;
  }
  return 1;
#endif
}

void rb_logging_remove_sublogger(const char* parent, const char* sub) {
#if !defined(RB_DISTRO_HUMBLE)
  if (rcl_logging_rosout_remove_sublogger(parent, sub) != RCL_RET_OK) rcl_reset_error();
#else
  (void)parent, (void)sub;
#endif
}

// The logger's own level (0 = unset), as the logger services report it.
int rb_logging_get_level(const char* name) {
  int level = rcutils_logging_get_logger_level(name);
  if (level < 0) rcutils_reset_error();
  return level < 0 ? 0 : level;
}

int rb_logging_get_effective_level(const char* name) {
  return rcutils_logging_get_logger_effective_level(name);
}

int rb_logging_is_enabled_for(const char* name, int severity) {
  return rcutils_logging_logger_is_enabled_for(name, severity) ? 1 : 0;
}

// ---------------------------------------------------------------------------
// publisher

typedef struct {
  rcl_publisher_t pub;
  rcl_node_t* node;
} rb_pub_t;

void* rb_pub_init(void* node, const void* ts, const char* topic, const int64_t* qos) {
  rb_pub_t* p = malloc(sizeof(*p));
  p->pub = rcl_get_zero_initialized_publisher();
  p->node = node;
  rcl_publisher_options_t o = rcl_publisher_get_default_options();
  rb_apply_qos(&o.qos, qos);
  rcl_ret_t ret = rcl_publisher_init(&p->pub, node, ts, topic, &o);
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("rcl_publisher_init", ret);
    free(p);
    return NULL;
  }
  return p;
}

int rb_pub_fini(void* pp) {
  rb_pub_t* p = pp;
  rcl_ret_t ret = rcl_publisher_fini(&p->pub, p->node);
  free(p);
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("rcl_publisher_fini", ret);
    return -1;
  }
  return 0;
}

int rb_pub_publish(void* pp, uint8_t* data, size_t len) {
  rb_pub_t* p = pp;
  rcl_serialized_message_t m = {data, len, len, rcutils_get_default_allocator()};
  rcl_ret_t ret = rcl_publish_serialized_message(&p->pub, &m, NULL);
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("rcl_publish_serialized_message", ret);
    return -1;
  }
  return 0;
}

const char* rb_pub_topic(void* pp) { return rcl_publisher_get_topic_name(&((rb_pub_t*)pp)->pub); }

int64_t rb_pub_subscription_count(void* pp) {
  size_t n = 0;
  if (rcl_publisher_get_subscription_count(&((rb_pub_t*)pp)->pub, &n) != RCL_RET_OK) {
    rb_take_rcl_error("rcl_publisher_get_subscription_count", 1);
    return -1;
  }
  return (int64_t)n;
}

int rb_pub_assert_liveliness(void* pp) {
  return rcl_publisher_assert_liveliness(&((rb_pub_t*)pp)->pub) == RCL_RET_OK ? 0 : -1;
}

int rb_pub_wait_for_all_acked(void* pp, int64_t timeout_ns) {
  rcl_ret_t ret = rcl_publisher_wait_for_all_acked(&((rb_pub_t*)pp)->pub, timeout_ns);
  if (ret == RCL_RET_OK) return 1;
  if (ret == RCL_RET_TIMEOUT) return 0;
  rb_take_rcl_error("rcl_publisher_wait_for_all_acked", ret);
  return -1;
}

const char* rb_pub_qos(void* pp) {
  const rmw_qos_profile_t* q = rcl_publisher_get_actual_qos(&((rb_pub_t*)pp)->pub);
  js_reset();
  if (q) js_qos(q);
  return g_json.buf;
}

// ---------------------------------------------------------------------------
// subscription (serialized take)

typedef struct {
  rcl_subscription_t sub;  // must stay first: the executor adds &sub
  rcl_node_t* node;
  rcl_serialized_message_t msg;
  rmw_message_info_t info;
  // rcl takes a shallow copy of the options and releases the content filter
  // strings itself in rcl_subscription_fini; only fini them on init failure
  rcl_subscription_options_t opts;
} rb_sub_t;

void* rb_sub_init(void* node, const void* ts, const char* topic, const int64_t* qos,
                  const char* filter_expr, int filter_argc, const char** filter_argv) {
  rb_sub_t* s = malloc(sizeof(*s));
  s->sub = rcl_get_zero_initialized_subscription();
  s->node = node;
  s->msg = rmw_get_zero_initialized_serialized_message();
  rcutils_allocator_t a = rcutils_get_default_allocator();
  rmw_serialized_message_init(&s->msg, 256, &a);
  s->opts = rcl_subscription_get_default_options();
  rcl_subscription_options_t* o = &s->opts;
  rb_apply_qos(&o->qos, qos);
  if (filter_expr && filter_expr[0]) {
    rcl_ret_t fr = rcl_subscription_options_set_content_filter_options(filter_expr, (size_t)filter_argc,
                                                                       filter_argv, o);
    if (fr != RCL_RET_OK) {
      rb_take_rcl_error("content filter options", fr);
      rmw_serialized_message_fini(&s->msg);
      free(s);
      return NULL;
    }
  }
  rcl_ret_t ret = rcl_subscription_init(&s->sub, node, ts, topic, o);
  if (ret != RCL_RET_OK) {
    (void)rcl_subscription_options_fini(o);
    rb_take_rcl_error("rcl_subscription_init", ret);
    rmw_serialized_message_fini(&s->msg);
    free(s);
    return NULL;
  }
  return s;
}

int rb_sub_fini(void* sp) {
  rb_sub_t* s = sp;
  rcl_ret_t ret = rcl_subscription_fini(&s->sub, s->node);
  rmw_serialized_message_fini(&s->msg);
  free(s);
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("rcl_subscription_fini", ret);
    return -1;
  }
  return 0;
}

// Takes one message. Returns its length and stores a pointer to the shim-owned
// buffer in *out (valid until the next take on this subscription); 0 if no
// message was available; <0 on error.
int64_t rb_sub_take(void* sp, uint8_t** out) {
  rb_sub_t* s = sp;
  rcl_ret_t ret = rcl_take_serialized_message(&s->sub, &s->msg, &s->info, NULL);
  if (ret == RCL_RET_SUBSCRIPTION_TAKE_FAILED) return 0;
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("rcl_take_serialized_message", ret);
    return -1;
  }
  *out = s->msg.buffer;
  return (int64_t)s->msg.buffer_length;
}

// Info of the last taken message: [source_timestamp, received_timestamp,
// publication_sequence_number, reception_sequence_number, from_intra_process]
void rb_sub_last_info(void* sp, int64_t* out) {
  rb_sub_t* s = sp;
  out[0] = s->info.source_timestamp;
  out[1] = s->info.received_timestamp;
  out[2] = (int64_t)s->info.publication_sequence_number;
  out[3] = (int64_t)s->info.reception_sequence_number;
  out[4] = s->info.from_intra_process ? 1 : 0;
}

// Sets (or clears, with an empty expression) the content filter at runtime.
int rb_sub_set_content_filter(void* sp, const char* expr, int argc, const char** argv) {
  rb_sub_t* s = sp;
  rcl_subscription_content_filter_options_t opts =
      rcl_get_zero_initialized_subscription_content_filter_options();
  rcl_ret_t ret = rcl_subscription_content_filter_options_init(&s->sub, expr, (size_t)argc, argv, &opts);
  if (ret == RCL_RET_OK) ret = rcl_subscription_set_content_filter(&s->sub, &opts);
  (void)rcl_subscription_content_filter_options_fini(&s->sub, &opts);
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("rcl_subscription_set_content_filter", ret);
    return -1;
  }
  return 0;
}

int rb_sub_is_cft_enabled(void* sp) {
  return rcl_subscription_is_cft_enabled(&((rb_sub_t*)sp)->sub) ? 1 : 0;
}

// JSON {"expression": "...", "parameters": [...]} or NULL when no filter is set.
const char* rb_sub_get_content_filter(void* sp) {
  rb_sub_t* s = sp;
  rcl_subscription_content_filter_options_t opts =
      rcl_get_zero_initialized_subscription_content_filter_options();
  rcl_ret_t ret = rcl_subscription_get_content_filter(&s->sub, &opts);
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("rcl_subscription_get_content_filter", ret);
    return NULL;
  }
  rmw_subscription_content_filter_options_t* f = &opts.rmw_subscription_content_filter_options;
  js_reset();
  js_lit("{\"expression\":");
  js_str(f->filter_expression);
  js_lit(",\"parameters\":[");
  for (size_t i = 0; i < f->expression_parameters.size; i++) {
    if (i) js_lit(",");
    js_str(f->expression_parameters.data[i]);
  }
  js_lit("]}");
  (void)rcl_subscription_content_filter_options_fini(&s->sub, &opts);
  return g_json.buf;
}

const char* rb_sub_topic(void* sp) { return rcl_subscription_get_topic_name(&((rb_sub_t*)sp)->sub); }

int64_t rb_sub_publisher_count(void* sp) {
  size_t n = 0;
  if (rcl_subscription_get_publisher_count(&((rb_sub_t*)sp)->sub, &n) != RCL_RET_OK) {
    rb_take_rcl_error("rcl_subscription_get_publisher_count", 1);
    return -1;
  }
  return (int64_t)n;
}

const char* rb_sub_qos(void* sp) {
  const rmw_qos_profile_t* q = rcl_subscription_get_actual_qos(&((rb_sub_t*)sp)->sub);
  js_reset();
  if (q) js_qos(q);
  return g_json.buf;
}

// ---------------------------------------------------------------------------
// loaned messages: C messages in middleware memory (Fast DDS: fixed-size types;
// subscriptions only when ROS_DISABLE_LOANED_MESSAGES=0)

int rb_pub_can_loan(void* pp) { return rcl_publisher_can_loan_messages(&((rb_pub_t*)pp)->pub) ? 1 : 0; }

// The loan comes uninitialized (Fast DDS); fill in the type's default values.
// Only fixed-size types can be loaned, so init allocates nothing.
void* rb_pub_borrow(void* pp, const void* ts) {
  void* msg = NULL;
  rcl_ret_t ret = rcl_borrow_loaned_message(&((rb_pub_t*)pp)->pub, ts, &msg);
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("rcl_borrow_loaned_message", ret);
    return NULL;
  }
  const rosidl_message_type_support_t* its =
      get_message_typesupport_handle(ts, rosidl_typesupport_introspection_c__identifier);
  if (its) {
    const rosidl_typesupport_introspection_c__MessageMembers* mm = its->data;
    memset(msg, 0, mm->size_of_);
    mm->init_function(msg, ROSIDL_RUNTIME_C_MSG_INIT_ALL);
  } else {
    rcutils_reset_error();
  }
  return msg;
}

// Publishing gives the loan back to the middleware, also when it fails.
int rb_pub_publish_loaned(void* pp, void* msg) {
  rcl_ret_t ret = rcl_publish_loaned_message(&((rb_pub_t*)pp)->pub, msg, NULL);
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("rcl_publish_loaned_message", ret);
    return -1;
  }
  return 0;
}

int rb_pub_return_loaned(void* pp, void* msg) {
  rcl_ret_t ret = rcl_return_loaned_message_from_publisher(&((rb_pub_t*)pp)->pub, msg);
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("rcl_return_loaned_message_from_publisher", ret);
    return -1;
  }
  return 0;
}

// Publishes a C message (the fallback when the middleware cannot loan).
int rb_pub_publish_c(void* pp, void* msg) {
  rcl_ret_t ret = rcl_publish(&((rb_pub_t*)pp)->pub, msg, NULL);
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("rcl_publish", ret);
    return -1;
  }
  return 0;
}

int rb_sub_can_loan(void* sp) { return rcl_subscription_can_loan_messages(&((rb_sub_t*)sp)->sub) ? 1 : 0; }

// 1 and the loan in *out, 0 if no message was available, <0 on error.
int rb_sub_take_loaned(void* sp, void** out) {
  rb_sub_t* s = sp;
  *out = NULL;
  rcl_ret_t ret = rcl_take_loaned_message(&s->sub, out, &s->info, NULL);
  if (ret == RCL_RET_SUBSCRIPTION_TAKE_FAILED) return 0;
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("rcl_take_loaned_message", ret);
    return -1;
  }
  return 1;
}

int rb_sub_return_loaned(void* sp, void* msg) {
  rcl_ret_t ret = rcl_return_loaned_message_from_subscription(&((rb_sub_t*)sp)->sub, msg);
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("rcl_return_loaned_message_from_subscription", ret);
    return -1;
  }
  return 0;
}

// Takes into a C message (the fallback when the middleware cannot loan); same
// return values as rb_sub_take_loaned.
int rb_sub_take_c(void* sp, void* msg) {
  rb_sub_t* s = sp;
  rcl_ret_t ret = rcl_take(&s->sub, msg, &s->info, NULL);
  if (ret == RCL_RET_SUBSCRIPTION_TAKE_FAILED) return 0;
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("rcl_take", ret);
    return -1;
  }
  return 1;
}

// ---------------------------------------------------------------------------
// QoS events. kind: 0 deadline, 1 liveliness, 2 incompatible_qos,
// 3 incompatible_type, 4 matched, 5 message_lost (subscription only)

typedef struct {
  rcl_event_t event;  // first: added to wait sets
  int is_sub;
  int kind;
} rb_event_t;

void* rb_event_init(void* entity, int is_sub, int kind) {
  rb_event_t* e = malloc(sizeof(*e));
  e->event = rcl_get_zero_initialized_event();
  e->is_sub = is_sub;
  e->kind = kind;
  rcl_ret_t ret = RCL_RET_ERROR;
#if defined(RB_DISTRO_HUMBLE)
  if (kind == 3 || kind == 4) {
    rb_set_error("QoS event kind %d is not available on Humble", kind);
    free(e);
    return NULL;
  }
#endif
  if (is_sub) {
    rcl_subscription_event_type_t t;
    switch (kind) {
      case 0: t = RCL_SUBSCRIPTION_REQUESTED_DEADLINE_MISSED; break;
      case 1: t = RCL_SUBSCRIPTION_LIVELINESS_CHANGED; break;
      case 2: t = RCL_SUBSCRIPTION_REQUESTED_INCOMPATIBLE_QOS; break;
#if !defined(RB_DISTRO_HUMBLE)
      case 3: t = RCL_SUBSCRIPTION_INCOMPATIBLE_TYPE; break;
      case 4: t = RCL_SUBSCRIPTION_MATCHED; break;
#endif
      default: t = RCL_SUBSCRIPTION_MESSAGE_LOST; break;
    }
    ret = rcl_subscription_event_init(&e->event, (rcl_subscription_t*)entity, t);
  } else {
    rcl_publisher_event_type_t t;
    switch (kind) {
      case 0: t = RCL_PUBLISHER_OFFERED_DEADLINE_MISSED; break;
      case 1: t = RCL_PUBLISHER_LIVELINESS_LOST; break;
      case 2: t = RCL_PUBLISHER_OFFERED_INCOMPATIBLE_QOS; break;
#if !defined(RB_DISTRO_HUMBLE)
      case 3: t = RCL_PUBLISHER_INCOMPATIBLE_TYPE; break;
      default: t = RCL_PUBLISHER_MATCHED; break;
#else
      default: t = RCL_PUBLISHER_LIVELINESS_LOST; break;
#endif
    }
    ret = rcl_publisher_event_init(&e->event, (rcl_publisher_t*)entity, t);
  }
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("rcl event init", ret);
    free(e);
    return NULL;
  }
  return e;
}

int rb_event_fini(void* ep) {
  rcl_ret_t ret = rcl_event_fini(&((rb_event_t*)ep)->event);
  free(ep);
  return ret == RCL_RET_OK ? 0 : -1;
}

// Takes the pending status as JSON (NULL on error).
const char* rb_event_take(void* ep) {
  rb_event_t* e = ep;
  union {
    rmw_offered_deadline_missed_status_t odm;
    rmw_requested_deadline_missed_status_t rdm;
    rmw_liveliness_lost_status_t ll;
    rmw_liveliness_changed_status_t lc;
    rmw_qos_incompatible_event_status_t qi;
#if !defined(RB_DISTRO_HUMBLE)
    rmw_incompatible_type_status_t it;
    rmw_matched_status_t m;
#endif
    rmw_message_lost_status_t ml;
  } st;
  memset(&st, 0, sizeof(st));
  rcl_ret_t ret = rcl_take_event(&e->event, &st);
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("rcl_take_event", ret);
    return NULL;
  }
  js_reset();
  switch (e->kind) {
    case 0:
      js_lit("{\"total_count\":"); js_int(st.odm.total_count);
      js_lit(",\"total_count_change\":"); js_int(st.odm.total_count_change); js_lit("}");
      break;
    case 1:
      if (e->is_sub) {
        js_lit("{\"alive_count\":"); js_int(st.lc.alive_count);
        js_lit(",\"not_alive_count\":"); js_int(st.lc.not_alive_count);
        js_lit(",\"alive_count_change\":"); js_int(st.lc.alive_count_change);
        js_lit(",\"not_alive_count_change\":"); js_int(st.lc.not_alive_count_change); js_lit("}");
      } else {
        js_lit("{\"total_count\":"); js_int(st.ll.total_count);
        js_lit(",\"total_count_change\":"); js_int(st.ll.total_count_change); js_lit("}");
      }
      break;
    case 2:
      js_lit("{\"total_count\":"); js_int(st.qi.total_count);
      js_lit(",\"total_count_change\":"); js_int(st.qi.total_count_change);
      js_lit(",\"last_policy_kind\":"); js_int(st.qi.last_policy_kind); js_lit("}");
      break;
#if !defined(RB_DISTRO_HUMBLE)
    case 3:
      js_lit("{\"total_count\":"); js_int(st.it.total_count);
      js_lit(",\"total_count_change\":"); js_int(st.it.total_count_change); js_lit("}");
      break;
    case 4:
      js_lit("{\"total_count\":"); js_int((int64_t)st.m.total_count);
      js_lit(",\"total_count_change\":"); js_int((int64_t)st.m.total_count_change);
      js_lit(",\"current_count\":"); js_int((int64_t)st.m.current_count);
      js_lit(",\"current_count_change\":"); js_int(st.m.current_count_change); js_lit("}");
      break;
#endif
    default:
      js_lit("{\"total_count\":"); js_int((int64_t)st.ml.total_count);
      js_lit(",\"total_count_change\":"); js_int((int64_t)st.ml.total_count_change); js_lit("}");
  }
  return g_json.buf;
}

// ---------------------------------------------------------------------------
// C message bridge (CDR <-> C struct) for services and actions

typedef struct {
  const rosidl_message_type_support_t* ts;
  const rosidl_typesupport_introspection_c__MessageMembers* members;
  void* msg;  // reusable, initialized C message
  rcl_serialized_message_t ser;
} rb_cmsg_t;

static int rb_cmsg_init(rb_cmsg_t* m, const rosidl_message_type_support_t* ts) {
  m->ts = ts;
  const rosidl_message_type_support_t* its =
      get_message_typesupport_handle(ts, rosidl_typesupport_introspection_c__identifier);
  if (!its) {
    rcutils_reset_error();
    rb_set_error("no introspection typesupport available for message");
    return -1;
  }
  m->members = its->data;
  m->msg = calloc(1, m->members->size_of_);
  m->members->init_function(m->msg, ROSIDL_RUNTIME_C_MSG_INIT_ALL);
  m->ser = rmw_get_zero_initialized_serialized_message();
  rcutils_allocator_t a = rcutils_get_default_allocator();
  rmw_serialized_message_init(&m->ser, 256, &a);
  return 0;
}

static void rb_cmsg_fini(rb_cmsg_t* m) {
  if (m->msg) {
    m->members->fini_function(m->msg);
    free(m->msg);
    m->msg = NULL;
  }
  rmw_serialized_message_fini(&m->ser);
}

// Returns m->msg to a freshly initialized state. Needed before every take into
// the reused message: rmw_cyclonedds deserializes strings/sequences without
// releasing what the previous take left there (Fast DDS reuses it).
static void rb_cmsg_reset(rb_cmsg_t* m) {
  m->members->fini_function(m->msg);
  memset(m->msg, 0, m->members->size_of_);
  m->members->init_function(m->msg, ROSIDL_RUNTIME_C_MSG_INIT_ALL);
}

// CDR bytes -> m->msg
static int rb_cmsg_from_cdr(rb_cmsg_t* m, uint8_t* data, size_t len) {
  rb_cmsg_reset(m);
  rmw_serialized_message_t in = {data, len, len, rcutils_get_default_allocator()};
  rmw_ret_t ret = rmw_deserialize(&in, m->ts, m->msg);
  if (ret != RMW_RET_OK) {
    rb_take_rcl_error("rmw_deserialize", ret);
    return -1;
  }
  return 0;
}

// m->msg -> m->ser (CDR); returns length
static int64_t rb_cmsg_to_cdr(rb_cmsg_t* m, uint8_t** out) {
  rmw_ret_t ret = rmw_serialize(m->msg, m->ts, &m->ser);
  if (ret != RMW_RET_OK) {
    rb_take_rcl_error("rmw_serialize", ret);
    return -1;
  }
  *out = m->ser.buffer;
  return (int64_t)m->ser.buffer_length;
}

// Generic round trip helpers used by tests and by actions.
void* rb_cmsg_new(const void* ts) {
  rb_cmsg_t* m = calloc(1, sizeof(*m));
  if (rb_cmsg_init(m, ts) != 0) {
    free(m);
    return NULL;
  }
  return m;
}
void rb_cmsg_free(void* m) {
  rb_cmsg_fini(m);
  free(m);
}
int rb_cmsg_load(void* m, uint8_t* data, size_t len) { return rb_cmsg_from_cdr(m, data, len); }
int64_t rb_cmsg_dump(void* m, uint8_t** out) { return rb_cmsg_to_cdr(m, out); }
void* rb_cmsg_ptr(void* m) { return ((rb_cmsg_t*)m)->msg; }

// Initialized C message of a type, for loaned-message fallbacks.
void* rb_msg_alloc(const void* ts) {
  const rosidl_message_type_support_t* its =
      get_message_typesupport_handle(ts, rosidl_typesupport_introspection_c__identifier);
  if (!its) {
    rcutils_reset_error();
    rb_set_error("no introspection typesupport available for message");
    return NULL;
  }
  const rosidl_typesupport_introspection_c__MessageMembers* mm = its->data;
  void* msg = calloc(1, mm->size_of_);
  mm->init_function(msg, ROSIDL_RUNTIME_C_MSG_INIT_ALL);
  return msg;
}

void rb_msg_free(const void* ts, void* msg) {
  const rosidl_message_type_support_t* its =
      get_message_typesupport_handle(ts, rosidl_typesupport_introspection_c__identifier);
  if (its) ((const rosidl_typesupport_introspection_c__MessageMembers*)its->data)->fini_function(msg);
  free(msg);
}

static void js_layout(const rosidl_typesupport_introspection_c__MessageMembers* mm) {
  js_lit("{\"size\":");
  js_int((int64_t)mm->size_of_);
  js_lit(",\"fields\":[");
  for (uint32_t i = 0; i < mm->member_count_; i++) {
    const rosidl_typesupport_introspection_c__MessageMember* f = &mm->members_[i];
    if (i) js_lit(",");
    js_lit("{\"name\":");
    js_str(f->name_);
    js_lit(",\"type\":");
    js_int(f->type_id_);
    js_lit(",\"offset\":");
    js_int(f->offset_);
    // array: 0 = not an array, N = fixed size N, -1 = sequence (bounded or not)
    js_lit(",\"array\":");
    js_int(!f->is_array_ ? 0 : (f->array_size_ > 0 && !f->is_upper_bound_) ? (int64_t)f->array_size_ : -1);
    if (f->type_id_ == rosidl_typesupport_introspection_c__ROS_TYPE_MESSAGE && f->members_) {
      js_lit(",\"message\":");
      js_layout(f->members_->data);
    }
    js_lit("}");
  }
  js_lit("]}");
}

// C struct layout of a message type from its introspection typesupport (JSON).
const char* rb_msg_layout(const void* ts) {
  const rosidl_message_type_support_t* its =
      get_message_typesupport_handle(ts, rosidl_typesupport_introspection_c__identifier);
  if (!its) {
    rcutils_reset_error();
    rb_set_error("no introspection typesupport available for message");
    return NULL;
  }
  js_reset();
  js_layout(its->data);
  return g_json.buf;
}

// ---------------------------------------------------------------------------
// client

typedef struct {
  rcl_client_t client;  // first
  rcl_node_t* node;
  rb_cmsg_t req, resp;
  int64_t last_seq;
} rb_client_t;

void* rb_client_init(void* node, const void* srv_ts, const char* name, const int64_t* qos,
                     const void* req_ts, const void* resp_ts) {
  rb_client_t* c = calloc(1, sizeof(*c));
  c->client = rcl_get_zero_initialized_client();
  c->node = node;
  if (rb_cmsg_init(&c->req, req_ts) != 0 || rb_cmsg_init(&c->resp, resp_ts) != 0) {
    free(c);
    return NULL;
  }
  rcl_client_options_t o = rcl_client_get_default_options();
  rb_apply_qos(&o.qos, qos);
  rcl_ret_t ret = rcl_client_init(&c->client, node, srv_ts, name, &o);
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("rcl_client_init", ret);
    rb_cmsg_fini(&c->req);
    rb_cmsg_fini(&c->resp);
    free(c);
    return NULL;
  }
  return c;
}

int rb_client_fini(void* cp) {
  rb_client_t* c = cp;
  rcl_ret_t ret = rcl_client_fini(&c->client, c->node);
  rb_cmsg_fini(&c->req);
  rb_cmsg_fini(&c->resp);
  free(c);
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("rcl_client_fini", ret);
    return -1;
  }
  return 0;
}

// Sends a CDR-encoded request. Returns the sequence number (>=0) or -1.
int64_t rb_client_send(void* cp, uint8_t* data, size_t len) {
  rb_client_t* c = cp;
  if (rb_cmsg_from_cdr(&c->req, data, len) != 0) return -1;
  int64_t seq = 0;
  rcl_ret_t ret = rcl_send_request(&c->client, c->req.msg, &seq);
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("rcl_send_request", ret);
    return -1;
  }
  return seq;
}

// Takes one response. Returns CDR length (>0), 0 if none, -1 on error.
int64_t rb_client_take(void* cp, int64_t* seq_out, uint8_t** out) {
  rb_client_t* c = cp;
  rmw_service_info_t info;
  rb_cmsg_reset(&c->resp);
  rcl_ret_t ret = rcl_take_response_with_info(&c->client, &info, c->resp.msg);
  if (ret == RCL_RET_CLIENT_TAKE_FAILED) return 0;
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("rcl_take_response", ret);
    return -1;
  }
  *seq_out = info.request_id.sequence_number;
  return rb_cmsg_to_cdr(&c->resp, out);
}

int rb_client_server_available(void* cp) {
  rb_client_t* c = cp;
  bool ok = false;
  rcl_ret_t ret = rcl_service_server_is_available(c->node, &c->client, &ok);
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("rcl_service_server_is_available", ret);
    return -1;
  }
  return ok ? 1 : 0;
}

const char* rb_client_service_name(void* cp) {
  return rcl_client_get_service_name(&((rb_client_t*)cp)->client);
}

// ---------------------------------------------------------------------------
// service

typedef struct {
  rcl_service_t service;  // first
  rcl_node_t* node;
  rb_cmsg_t req, resp;
} rb_service_t;

void* rb_service_init(void* node, const void* srv_ts, const char* name, const int64_t* qos,
                      const void* req_ts, const void* resp_ts) {
  rb_service_t* s = calloc(1, sizeof(*s));
  s->service = rcl_get_zero_initialized_service();
  s->node = node;
  if (rb_cmsg_init(&s->req, req_ts) != 0 || rb_cmsg_init(&s->resp, resp_ts) != 0) {
    free(s);
    return NULL;
  }
  rcl_service_options_t o = rcl_service_get_default_options();
  rb_apply_qos(&o.qos, qos);
  rcl_ret_t ret = rcl_service_init(&s->service, node, srv_ts, name, &o);
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("rcl_service_init", ret);
    rb_cmsg_fini(&s->req);
    rb_cmsg_fini(&s->resp);
    free(s);
    return NULL;
  }
  return s;
}

int rb_service_fini(void* sp) {
  rb_service_t* s = sp;
  rcl_ret_t ret = rcl_service_fini(&s->service, s->node);
  rb_cmsg_fini(&s->req);
  rb_cmsg_fini(&s->resp);
  free(s);
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("rcl_service_fini", ret);
    return -1;
  }
  return 0;
}

// Takes one request. Returns CDR length (>0), 0 if none, -1 on error.
// *header_out receives a heap rmw_request_id_t that must be handed back to
// rb_service_send (or rb_free).
int64_t rb_service_take(void* sp, void** header_out, uint8_t** out) {
  rb_service_t* s = sp;
  rmw_service_info_t info;
  rb_cmsg_reset(&s->req);
  rcl_ret_t ret = rcl_take_request_with_info(&s->service, &info, s->req.msg);
  if (ret == RCL_RET_SERVICE_TAKE_FAILED) return 0;
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("rcl_take_request", ret);
    return -1;
  }
  rmw_request_id_t* h = malloc(sizeof(*h));
  *h = info.request_id;
  *header_out = h;
  return rb_cmsg_to_cdr(&s->req, out);
}

int rb_service_send(void* sp, void* header, uint8_t* data, size_t len) {
  rb_service_t* s = sp;
  int rc = 0;
  if (rb_cmsg_from_cdr(&s->resp, data, len) != 0) {
    rc = -1;
  } else {
    rcl_ret_t ret = rcl_send_response(&s->service, (rmw_request_id_t*)header, s->resp.msg);
    if (ret != RCL_RET_OK) {
      rb_take_rcl_error("rcl_send_response", ret);
      rc = -1;
    }
  }
  free(header);
  return rc;
}

const char* rb_service_name(void* sp) {
  return rcl_service_get_service_name(&((rb_service_t*)sp)->service);
}

void rb_free(void* p) { free(p); }

// ---------------------------------------------------------------------------
// service introspection and ~/get_type_description (not on Humble)

int rb_service_configure_introspection(void* sp, void* clock, const void* srv_ts, const int64_t* qos, int state) {
#if defined(RB_DISTRO_HUMBLE)
  (void)sp, (void)clock, (void)srv_ts, (void)qos, (void)state;
  rb_set_error("service introspection is not available on Humble");
  return -1;
#else
  rb_service_t* s = sp;
  rcl_publisher_options_t o = rcl_publisher_get_default_options();
  rb_apply_qos(&o.qos, qos);
  rcl_ret_t ret = rcl_service_configure_service_introspection(&s->service, s->node, (rcl_clock_t*)clock, srv_ts, o,
                                                             (rcl_service_introspection_state_t)state);
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("rcl_service_configure_service_introspection", ret);
    return -1;
  }
  return 0;
#endif
}

int rb_client_configure_introspection(void* cp, void* clock, const void* srv_ts, const int64_t* qos, int state) {
#if defined(RB_DISTRO_HUMBLE)
  (void)cp, (void)clock, (void)srv_ts, (void)qos, (void)state;
  rb_set_error("service introspection is not available on Humble");
  return -1;
#else
  rb_client_t* c = cp;
  rcl_publisher_options_t o = rcl_publisher_get_default_options();
  rb_apply_qos(&o.qos, qos);
  rcl_ret_t ret = rcl_client_configure_service_introspection(&c->client, c->node, (rcl_clock_t*)clock, srv_ts, o,
                                                            (rcl_service_introspection_state_t)state);
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("rcl_client_configure_service_introspection", ret);
    return -1;
  }
  return 0;
#endif
}

// The ~/get_type_description service is created by rcl and answered from the
// node's type cache; it is returned as an rb_service_t so rb_service_fini and
// the executor treat it like any other service.
void* rb_type_description_service_init(void* node, const void* req_ts, const void* resp_ts) {
#if defined(RB_DISTRO_HUMBLE)
  (void)node, (void)req_ts, (void)resp_ts;
  rb_set_error("the type description service is not available on Humble");
  return NULL;
#else
  rb_service_t* s = calloc(1, sizeof(*s));
  s->service = rcl_get_zero_initialized_service();
  s->node = node;
  if (rb_cmsg_init(&s->req, req_ts) != 0 || rb_cmsg_init(&s->resp, resp_ts) != 0) {
    free(s);
    return NULL;
  }
  rcl_ret_t ret = rcl_node_type_description_service_init(&s->service, node);
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("rcl_node_type_description_service_init", ret);
    rb_cmsg_fini(&s->req);
    rb_cmsg_fini(&s->resp);
    free(s);
    return NULL;
  }
  return s;
#endif
}

// Takes and answers one request: 1 if handled, 0 if none was pending, -1 on error.
int rb_type_description_service_handle(void* sp) {
#if defined(RB_DISTRO_HUMBLE)
  (void)sp;
  return -1;
#else
  rb_service_t* s = sp;
  rmw_service_info_t info;
  rb_cmsg_reset(&s->req);
  rcl_ret_t ret = rcl_take_request_with_info(&s->service, &info, s->req.msg);
  if (ret == RCL_RET_SERVICE_TAKE_FAILED) return 0;
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("rcl_take_request", ret);
    return -1;
  }
  rb_cmsg_reset(&s->resp);
  rcl_node_type_description_service_handle_request(s->node, &info.request_id, s->req.msg, s->resp.msg);
  ret = rcl_send_response(&s->service, &info.request_id, s->resp.msg);
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("rcl_send_response", ret);
    return -1;
  }
  return 1;
#endif
}

// Writes the RIHS type hash of a message type support ("RIHS01_<hex>") or "".
const char* rb_message_type_hash(const void* ts) {
  js_reset();
#if !defined(RB_DISTRO_HUMBLE)
  const rosidl_message_type_support_t* t = ts;
  if (t && t->get_type_hash_func) {
    char* str = NULL;
    if (rosidl_stringify_type_hash(t->get_type_hash_func(t), rcutils_get_default_allocator(), &str) == RCUTILS_RET_OK) {
      js_lit(str);
      free(str);
    }
  }
#else
  (void)ts;
#endif
  return g_json.buf;
}

// Bit flags for optional rcl features compiled into this shim.
enum {
  RB_F_TIMER_CALL_INFO = 1,
  RB_F_SERVICE_INTROSPECTION = 2,
  RB_F_TYPE_DESCRIPTION = 4,
  RB_F_MATCHED_EVENTS = 8,
  RB_F_LOGGER_SERVICE = 16,  // rcl_interfaces/srv/{Get,Set}LoggerLevels exist (Iron+)
  RB_F_ROSOUT_SUBLOGGERS = 32,
  RB_F_SERVICE_ENDPOINT_INFO = 64,  // service endpoint info + action counts (Lyrical+)
  RB_F_ACTION_ENDPOINT_INFO = 128,  // Rolling
};

int rb_features(void) {
  int f = 0;
#if !defined(RB_DISTRO_HUMBLE)
  f |= RB_F_TIMER_CALL_INFO | RB_F_SERVICE_INTROSPECTION | RB_F_TYPE_DESCRIPTION | RB_F_MATCHED_EVENTS |
       RB_F_LOGGER_SERVICE | RB_F_ROSOUT_SUBLOGGERS;
#endif
#if RB_HAS_SERVICE_ENDPOINT_INFO
  f |= RB_F_SERVICE_ENDPOINT_INFO;
#endif
#if RB_HAS_ACTION_ENDPOINT_INFO
  f |= RB_F_ACTION_ENDPOINT_INFO;
#endif
  return f;
}

// ---------------------------------------------------------------------------
// clock

void* rb_clock_init(int type) {
  rcl_clock_t* c = malloc(sizeof(*c));
  rcl_allocator_t alloc = rcl_get_default_allocator();
  rcl_ret_t ret = rcl_clock_init((rcl_clock_type_t)type, c, &alloc);
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("rcl_clock_init", ret);
    free(c);
    return NULL;
  }
  return c;
}

int rb_clock_fini(void* c) {
  rcl_ret_t ret = rcl_clock_fini((rcl_clock_t*)c);
  free(c);
  return ret == RCL_RET_OK ? 0 : -1;
}

int64_t rb_clock_now(void* c) {
  rcl_time_point_value_t t = 0;
  if (rcl_clock_get_now((rcl_clock_t*)c, &t) != RCL_RET_OK) {
    rb_take_rcl_error("rcl_clock_get_now", 1);
    return INT64_MIN;
  }
  return t;
}

int rb_clock_type(void* c) { return (int)((rcl_clock_t*)c)->type; }

int rb_clock_enable_ros_time_override(void* c, int enabled) {
  rcl_clock_t* clk = c;
  rcl_ret_t ret = enabled ? rcl_enable_ros_time_override(clk) : rcl_disable_ros_time_override(clk);
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("ros time override", ret);
    return -1;
  }
  return 0;
}

int rb_clock_set_ros_time_override(void* c, int64_t t) {
  rcl_ret_t ret = rcl_set_ros_time_override((rcl_clock_t*)c, t);
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("rcl_set_ros_time_override", ret);
    return -1;
  }
  return 0;
}

int rb_clock_ros_time_override_enabled(void* c) {
  bool en = false;
  if (rcl_is_enabled_ros_time_override((rcl_clock_t*)c, &en) != RCL_RET_OK) {
    rcl_reset_error();
    return -1;
  }
  return en ? 1 : 0;
}

// Clock jump callbacks. rcl runs them synchronously inside
// rcl_{enable,disable,set}_ros_time_override, which only the JS thread calls,
// so a single non-threadsafe JS handler receives every jump, keyed by an id
// passed as user_data.

typedef void (*rb_jump_handler_t)(int32_t id, int32_t before, int32_t change, int64_t delta);
static rb_jump_handler_t g_jump_handler;

void rb_set_jump_handler(void* h) { g_jump_handler = (rb_jump_handler_t)h; }

static void rb_jump_trampoline(const rcl_time_jump_t* j, bool before, void* user) {
  if (g_jump_handler) {
    g_jump_handler((int32_t)(intptr_t)user, before ? 1 : 0, (int32_t)j->clock_change, j->delta.nanoseconds);
  }
}

int rb_clock_add_jump_callback(void* c, int32_t id, int on_change, int64_t min_forward, int64_t min_backward) {
  rcl_jump_threshold_t th;
  th.on_clock_change = on_change != 0;
  th.min_forward.nanoseconds = min_forward;
  th.min_backward.nanoseconds = min_backward;
  rcl_ret_t ret = rcl_clock_add_jump_callback((rcl_clock_t*)c, th, rb_jump_trampoline, (void*)(intptr_t)id);
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("rcl_clock_add_jump_callback", ret);
    return -1;
  }
  return 0;
}

int rb_clock_remove_jump_callback(void* c, int32_t id) {
  rcl_ret_t ret = rcl_clock_remove_jump_callback((rcl_clock_t*)c, rb_jump_trampoline, (void*)(intptr_t)id);
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("rcl_clock_remove_jump_callback", ret);
    return -1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// timer

typedef struct {
  rcl_timer_t timer;  // first
} rb_timer_t;

void* rb_timer_init(void* ctx, void* clock, int64_t period_ns, int autostart) {
  rb_timer_t* t = malloc(sizeof(*t));
  t->timer = rcl_get_zero_initialized_timer();
#if defined(RB_DISTRO_HUMBLE)
  rcl_ret_t ret = rcl_timer_init(&t->timer, (rcl_clock_t*)clock, (rcl_context_t*)ctx, period_ns, NULL,
                                 rcl_get_default_allocator());
  if (ret == RCL_RET_OK && !autostart) (void)rcl_timer_cancel(&t->timer);
#else
  rcl_ret_t ret = rcl_timer_init2(&t->timer, (rcl_clock_t*)clock, (rcl_context_t*)ctx, period_ns,
                                  NULL, rcl_get_default_allocator(), autostart != 0);
#endif
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("rcl_timer_init", ret);
    free(t);
    return NULL;
  }
  return t;
}

int rb_timer_fini(void* tp) {
  rcl_ret_t ret = rcl_timer_fini(&((rb_timer_t*)tp)->timer);
  free(tp);
  return ret == RCL_RET_OK ? 0 : -1;
}

// Returns 1 if the timer was ready and its "call" was recorded, 0 if not ready
// (or canceled), -1 on error. On 1, out[0] / out[1] receive the expected and
// actual call times (Humble has no rcl_timer_call_with_info, so they are
// derived from the clock there).
int rb_timer_call(void* tp, int64_t* out) {
  rcl_timer_t* t = &((rb_timer_t*)tp)->timer;
  bool ready = false;
  if (rcl_timer_is_ready(t, &ready) != RCL_RET_OK) {
    rb_take_rcl_error("rcl_timer_is_ready", 1);
    return -1;
  }
  if (!ready) return 0;
#if defined(RB_DISTRO_HUMBLE)
  int64_t until = 0;
  rcl_time_point_value_t now = 0;
  rcl_clock_t* clock = NULL;
  (void)rcl_timer_get_time_until_next_call(t, &until);
  if (rcl_timer_clock(t, &clock) == RCL_RET_OK) (void)rcl_clock_get_now(clock, &now);
  rcl_ret_t ret = rcl_timer_call(t);
  out[0] = now + until;
  out[1] = now;
#else
  rcl_timer_call_info_t info;
  rcl_ret_t ret = rcl_timer_call_with_info(t, &info);
  out[0] = info.expected_call_time;
  out[1] = info.actual_call_time;
#endif
  if (ret == RCL_RET_TIMER_CANCELED) return 0;
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("rcl_timer_call", ret);
    return -1;
  }
  return 1;
}

int rb_timer_cancel(void* tp) { return rcl_timer_cancel(&((rb_timer_t*)tp)->timer) == RCL_RET_OK ? 0 : -1; }
int rb_timer_reset(void* tp) { return rcl_timer_reset(&((rb_timer_t*)tp)->timer) == RCL_RET_OK ? 0 : -1; }

int rb_timer_is_canceled(void* tp) {
  bool c = false;
  rcl_timer_is_canceled(&((rb_timer_t*)tp)->timer, &c);
  return c ? 1 : 0;
}

int64_t rb_timer_period(void* tp) {
  int64_t p = 0;
  rcl_timer_get_period(&((rb_timer_t*)tp)->timer, &p);
  return p;
}

int64_t rb_timer_change_period(void* tp, int64_t period) {
  int64_t old = 0;
  if (rcl_timer_exchange_period(&((rb_timer_t*)tp)->timer, period, &old) != RCL_RET_OK) return -1;
  return old;
}

int64_t rb_timer_time_until_next_call(void* tp) {
  int64_t v = 0;
  rcl_ret_t ret = rcl_timer_get_time_until_next_call(&((rb_timer_t*)tp)->timer, &v);
  if (ret == RCL_RET_TIMER_CANCELED) return INT64_MIN;
  return v;
}

int64_t rb_timer_time_since_last_call(void* tp) {
  int64_t v = 0;
  rcl_timer_get_time_since_last_call(&((rb_timer_t*)tp)->timer, &v);
  return v;
}

// ---------------------------------------------------------------------------
// guard condition

void* rb_guard_init(void* ctx) {
  rcl_guard_condition_t* g = malloc(sizeof(*g));
  *g = rcl_get_zero_initialized_guard_condition();
  rcl_ret_t ret = rcl_guard_condition_init(g, (rcl_context_t*)ctx, rcl_guard_condition_get_default_options());
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("rcl_guard_condition_init", ret);
    free(g);
    return NULL;
  }
  return g;
}

int rb_guard_fini(void* g) {
  rcl_ret_t ret = rcl_guard_condition_fini((rcl_guard_condition_t*)g);
  free(g);
  return ret == RCL_RET_OK ? 0 : -1;
}

int rb_guard_trigger(void* g) {
  return rcl_trigger_guard_condition((rcl_guard_condition_t*)g) == RCL_RET_OK ? 0 : -1;
}

// ---------------------------------------------------------------------------
// executor: one background thread that blocks in rcl_wait and notifies JS.
//
// Protocol (all calls except the callback happen on the JS thread):
//   rb_exec_arm(e, packed, timeout)  fills the wait set and lets the thread wait;
//   thread: rcl_wait -> records ready flags -> state=DONE -> cb(ret)  (queued to JS)
//   JS callback reads rb_exec_ready_ptr(), processes, then arms again.
//   rb_exec_interrupt(e)            wakes a pending wait (asynchronously);
//   rb_exec_interrupt_sync(e)       wakes it and blocks until rcl_wait returned,
//                                   so entities can be destroyed safely.
// packed layout (uint64): [nsubs, p..., nguards, p..., ntimers, p...,
//                          nclients, p..., nservices, p..., nevents, p...]

enum { RB_IDLE = 0, RB_ARMED = 1, RB_DONE = 2 };
enum { RB_K_SUB, RB_K_GUARD, RB_K_TIMER, RB_K_CLIENT, RB_K_SERVICE, RB_K_EVENT, RB_K_COUNT };

typedef void (*rb_exec_cb)(int32_t);

typedef struct {
  rcl_context_t* ctx;
  rcl_wait_set_t ws;
  rcl_guard_condition_t intr;
  pthread_t th;
  sem_t go;
  pthread_mutex_t mu;
  pthread_cond_t cv;
  int state;
  volatile int stop;
  rb_exec_cb cb;
  int64_t timeout;
  size_t counts[RB_K_COUNT];
  uint8_t* ready;
  size_t ready_cap;
  int32_t last_ret;
} rb_exec_t;

static void rb_exec_record(rb_exec_t* e) {
  size_t off = 0;
  for (size_t i = 0; i < e->counts[RB_K_SUB]; i++) e->ready[off++] = e->ws.subscriptions[i] != NULL;
  for (size_t i = 0; i < e->counts[RB_K_GUARD]; i++) e->ready[off++] = e->ws.guard_conditions[i] != NULL;
  for (size_t i = 0; i < e->counts[RB_K_TIMER]; i++) e->ready[off++] = e->ws.timers[i] != NULL;
  for (size_t i = 0; i < e->counts[RB_K_CLIENT]; i++) e->ready[off++] = e->ws.clients[i] != NULL;
  for (size_t i = 0; i < e->counts[RB_K_SERVICE]; i++) e->ready[off++] = e->ws.services[i] != NULL;
  for (size_t i = 0; i < e->counts[RB_K_EVENT]; i++) e->ready[off++] = e->ws.events[i] != NULL;
}

// RCLBUN_EXEC_STATS=1: every 5 s, print to stderr how often this thread woke up
// and which kinds of entities were ready (diagnoses busy wake-ups and stalls).
static void rb_exec_stats(rb_exec_t* e, uint64_t* waits, uint64_t* kinds, struct timespec* last) {
  struct timespec now;
  clock_gettime(CLOCK_MONOTONIC, &now);
  if (now.tv_sec - last->tv_sec < 5) return;
  fprintf(stderr, "[rclbunjs exec %p] waits=%llu ready: sub=%llu guard=%llu timer=%llu client=%llu service=%llu event=%llu none=%llu\n",
          (void*)e, (unsigned long long)*waits, (unsigned long long)kinds[0], (unsigned long long)kinds[1],
          (unsigned long long)kinds[2], (unsigned long long)kinds[3], (unsigned long long)kinds[4],
          (unsigned long long)kinds[5], (unsigned long long)kinds[6]);
  *waits = 0;
  memset(kinds, 0, sizeof(uint64_t) * 7);
  *last = now;
}

static void rb_exec_count(rb_exec_t* e, uint64_t* kinds) {
  size_t off = 0;
  int any = 0;
  for (int k = 0; k < RB_K_COUNT; k++) {
    for (size_t i = 0; i < e->counts[k]; i++) {
      if (e->ready[off++]) {
        kinds[k]++;
        any = 1;
      }
    }
  }
  if (!any) kinds[6]++;
}

static void* rb_exec_loop(void* arg) {
  rb_exec_t* e = arg;
  const char* sv = getenv("RCLBUN_EXEC_STATS");
  int stats = sv && sv[0] == '1';
  uint64_t waits = 0, kinds[7] = {0};
  struct timespec last;
  clock_gettime(CLOCK_MONOTONIC, &last);
  for (;;) {
    sem_wait(&e->go);
    if (e->stop) break;
    rcl_ret_t ret = rcl_wait(&e->ws, e->timeout);
    int32_t code = 0;
    if (stats) waits++;
    if (ret == RCL_RET_OK) {
      rb_exec_record(e);
      if (stats) rb_exec_count(e, kinds);
    } else if (ret == RCL_RET_TIMEOUT) {
      code = 1;
    } else {
      code = -1;
      rb_take_rcl_error("rcl_wait", ret);
    }
    pthread_mutex_lock(&e->mu);
    e->state = RB_DONE;
    e->last_ret = code;
    pthread_cond_broadcast(&e->cv);
    pthread_mutex_unlock(&e->mu);
    if (e->stop) break;
    if (stats) rb_exec_stats(e, &waits, kinds, &last);
    e->cb(code);
  }
  return NULL;
}

void* rb_exec_create(void* ctx, rb_exec_cb cb) {
  rb_exec_t* e = calloc(1, sizeof(*e));
  e->ctx = ctx;
  e->cb = cb;
  e->ws = rcl_get_zero_initialized_wait_set();
  e->intr = rcl_get_zero_initialized_guard_condition();
  rcl_ret_t ret = rcl_guard_condition_init(&e->intr, e->ctx, rcl_guard_condition_get_default_options());
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("rcl_guard_condition_init", ret);
    free(e);
    return NULL;
  }
  ret = rcl_wait_set_init(&e->ws, 0, 1, 0, 0, 0, 0, e->ctx, rcl_get_default_allocator());
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("rcl_wait_set_init", ret);
    rcl_guard_condition_fini(&e->intr);
    free(e);
    return NULL;
  }
  e->ready_cap = 64;
  e->ready = calloc(1, e->ready_cap);
  sem_init(&e->go, 0, 0);
  pthread_mutex_init(&e->mu, NULL);
  pthread_cond_init(&e->cv, NULL);
  pthread_create(&e->th, NULL, rb_exec_loop, e);
  return e;
}

int rb_exec_arm(void* ep, const uint64_t* packed, int64_t timeout_ns) {
  rb_exec_t* e = ep;
  pthread_mutex_lock(&e->mu);
  if (e->state == RB_ARMED) {
    pthread_mutex_unlock(&e->mu);
    rb_set_error("executor already armed");
    return -1;
  }
  pthread_mutex_unlock(&e->mu);

  size_t off = 0, total = 0;
  for (int k = 0; k < RB_K_COUNT; k++) {
    e->counts[k] = (size_t)packed[off];
    total += e->counts[k];
    off += 1 + e->counts[k];
  }
  rcl_ret_t ret = rcl_wait_set_resize(&e->ws, e->counts[RB_K_SUB], e->counts[RB_K_GUARD] + 1,
                                      e->counts[RB_K_TIMER], e->counts[RB_K_CLIENT],
                                      e->counts[RB_K_SERVICE], e->counts[RB_K_EVENT]);
  if (ret == RCL_RET_OK) ret = rcl_wait_set_clear(&e->ws);
  off = 0;
  for (int k = 0; k < RB_K_COUNT && ret == RCL_RET_OK; k++) {
    size_t n = (size_t)packed[off++];
    for (size_t i = 0; i < n && ret == RCL_RET_OK; i++) {
      void* p = (void*)(uintptr_t)packed[off++];
      switch (k) {
        case RB_K_SUB: ret = rcl_wait_set_add_subscription(&e->ws, p, NULL); break;
        case RB_K_GUARD: ret = rcl_wait_set_add_guard_condition(&e->ws, p, NULL); break;
        case RB_K_TIMER: ret = rcl_wait_set_add_timer(&e->ws, p, NULL); break;
        case RB_K_CLIENT: ret = rcl_wait_set_add_client(&e->ws, p, NULL); break;
        case RB_K_SERVICE: ret = rcl_wait_set_add_service(&e->ws, p, NULL); break;
        case RB_K_EVENT: ret = rcl_wait_set_add_event(&e->ws, p, NULL); break;
      }
    }
  }
  if (ret == RCL_RET_OK) ret = rcl_wait_set_add_guard_condition(&e->ws, &e->intr, NULL);
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("wait set fill", ret);
    return -1;
  }
  if (total > e->ready_cap) {
    free(e->ready);
    e->ready_cap = total * 2;
    e->ready = calloc(1, e->ready_cap);
  }
  memset(e->ready, 0, e->ready_cap);
  e->timeout = timeout_ns;
  pthread_mutex_lock(&e->mu);
  e->state = RB_ARMED;
  pthread_mutex_unlock(&e->mu);
  sem_post(&e->go);
  return 0;
}

uint8_t* rb_exec_ready_ptr(void* ep) { return ((rb_exec_t*)ep)->ready; }
int64_t rb_exec_ready_cap(void* ep) { return (int64_t)((rb_exec_t*)ep)->ready_cap; }

void rb_exec_interrupt(void* ep) { rcl_trigger_guard_condition(&((rb_exec_t*)ep)->intr); }

// Returns 1 if a wait was pending and has now returned, 0 if nothing was armed.
int rb_exec_interrupt_sync(void* ep) {
  rb_exec_t* e = ep;
  pthread_mutex_lock(&e->mu);
  if (e->state != RB_ARMED) {
    pthread_mutex_unlock(&e->mu);
    return 0;
  }
  rcl_trigger_guard_condition(&e->intr);
  while (e->state == RB_ARMED) pthread_cond_wait(&e->cv, &e->mu);
  pthread_mutex_unlock(&e->mu);
  return 1;
}

void rb_exec_destroy(void* ep) {
  rb_exec_t* e = ep;
  e->stop = 1;
  rcl_trigger_guard_condition(&e->intr);
  sem_post(&e->go);
  pthread_join(e->th, NULL);
  rcl_wait_set_fini(&e->ws);
  rcl_guard_condition_fini(&e->intr);
  sem_destroy(&e->go);
  pthread_mutex_destroy(&e->mu);
  pthread_cond_destroy(&e->cv);
  free(e->ready);
  free(e);
}

// Synchronous variant for spinOnce(): waits on the JS thread.
// Same packed layout; ready flags written to `ready` (caller-owned).
int rb_wait_sync(void* ctx, const uint64_t* packed, int64_t timeout_ns, uint8_t* ready) {
  rcl_wait_set_t ws = rcl_get_zero_initialized_wait_set();
  size_t counts[RB_K_COUNT], off = 0;
  for (int k = 0; k < RB_K_COUNT; k++) {
    counts[k] = (size_t)packed[off];
    off += 1 + counts[k];
  }
  rcl_ret_t ret = rcl_wait_set_init(&ws, counts[0], counts[1], counts[2], counts[3], counts[4],
                                    counts[5], ctx, rcl_get_default_allocator());
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("rcl_wait_set_init", ret);
    return -1;
  }
  off = 0;
  for (int k = 0; k < RB_K_COUNT && ret == RCL_RET_OK; k++) {
    size_t n = (size_t)packed[off++];
    for (size_t i = 0; i < n && ret == RCL_RET_OK; i++) {
      void* p = (void*)(uintptr_t)packed[off++];
      switch (k) {
        case RB_K_SUB: ret = rcl_wait_set_add_subscription(&ws, p, NULL); break;
        case RB_K_GUARD: ret = rcl_wait_set_add_guard_condition(&ws, p, NULL); break;
        case RB_K_TIMER: ret = rcl_wait_set_add_timer(&ws, p, NULL); break;
        case RB_K_CLIENT: ret = rcl_wait_set_add_client(&ws, p, NULL); break;
        case RB_K_SERVICE: ret = rcl_wait_set_add_service(&ws, p, NULL); break;
        case RB_K_EVENT: ret = rcl_wait_set_add_event(&ws, p, NULL); break;
      }
    }
  }
  int code = 0;
  if (ret == RCL_RET_OK) ret = rcl_wait(&ws, timeout_ns);
  if (ret == RCL_RET_OK) {
    size_t o = 0;
    for (size_t i = 0; i < counts[0]; i++) ready[o++] = ws.subscriptions[i] != NULL;
    for (size_t i = 0; i < counts[1]; i++) ready[o++] = ws.guard_conditions[i] != NULL;
    for (size_t i = 0; i < counts[2]; i++) ready[o++] = ws.timers[i] != NULL;
    for (size_t i = 0; i < counts[3]; i++) ready[o++] = ws.clients[i] != NULL;
    for (size_t i = 0; i < counts[4]; i++) ready[o++] = ws.services[i] != NULL;
    for (size_t i = 0; i < counts[5]; i++) ready[o++] = ws.events[i] != NULL;
  } else if (ret == RCL_RET_TIMEOUT || ret == RCL_RET_WAIT_SET_EMPTY) {
    code = 1;
  } else {
    rb_take_rcl_error("rcl_wait", ret);
    code = -1;
  }
  rcl_wait_set_fini(&ws);
  return code;
}

// ---------------------------------------------------------------------------
// graph

static void js_names_and_types(rcl_names_and_types_t* nt) {
  js_lit("[");
  for (size_t i = 0; i < nt->names.size; i++) {
    if (i) js_lit(",");
    js_lit("{\"name\":");
    js_str(nt->names.data[i]);
    js_lit(",\"types\":[");
    for (size_t j = 0; j < nt->types[i].size; j++) {
      if (j) js_lit(",");
      js_str(nt->types[i].data[j]);
    }
    js_lit("]}");
  }
  js_lit("]");
}

// kind: 0 topics, 1 services, 2 publishers-by-node, 3 subscriptions-by-node,
//       4 services-by-node, 5 clients-by-node
const char* rb_graph_names_and_types(void* node, int kind, const char* node_name,
                                     const char* node_ns, int no_demangle) {
  rcl_allocator_t alloc = rcl_get_default_allocator();
  rcl_names_and_types_t nt = rcl_get_zero_initialized_names_and_types();
  rcl_ret_t ret = RCL_RET_ERROR;
  rcl_node_t* n = node;
  switch (kind) {
    case 0: ret = rcl_get_topic_names_and_types(n, &alloc, no_demangle != 0, &nt); break;
    case 1: ret = rcl_get_service_names_and_types(n, &alloc, &nt); break;
    case 2: ret = rcl_get_publisher_names_and_types_by_node(n, &alloc, no_demangle != 0, node_name, node_ns, &nt); break;
    case 3: ret = rcl_get_subscriber_names_and_types_by_node(n, &alloc, no_demangle != 0, node_name, node_ns, &nt); break;
    case 4: ret = rcl_get_service_names_and_types_by_node(n, &alloc, node_name, node_ns, &nt); break;
    case 5: ret = rcl_get_client_names_and_types_by_node(n, &alloc, node_name, node_ns, &nt); break;
  }
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("rcl graph query", ret);
    rcl_names_and_types_fini(&nt);
    return NULL;
  }
  js_reset();
  js_names_and_types(&nt);
  rcl_names_and_types_fini(&nt);
  return g_json.buf;
}

const char* rb_graph_node_names(void* node, int with_enclaves) {
  rcl_allocator_t alloc = rcl_get_default_allocator();
  rcutils_string_array_t names = rcutils_get_zero_initialized_string_array();
  rcutils_string_array_t nss = rcutils_get_zero_initialized_string_array();
  rcutils_string_array_t encl = rcutils_get_zero_initialized_string_array();
  rcl_ret_t ret = with_enclaves
                      ? rcl_get_node_names_with_enclaves(node, alloc, &names, &nss, &encl)
                      : rcl_get_node_names(node, alloc, &names, &nss);
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("rcl_get_node_names", ret);
    return NULL;
  }
  js_reset();
  js_lit("[");
  for (size_t i = 0; i < names.size; i++) {
    if (i) js_lit(",");
    js_lit("{\"name\":");
    js_str(names.data[i]);
    js_lit(",\"namespace\":");
    js_str(nss.data[i]);
    if (with_enclaves) {
      js_lit(",\"enclave\":");
      js_str(encl.data[i]);
    }
    js_lit("}");
  }
  js_lit("]");
  rcutils_string_array_fini(&names);
  rcutils_string_array_fini(&nss);
  if (with_enclaves) rcutils_string_array_fini(&encl);
  return g_json.buf;
}

// kind: 0 publishers, 1 subscribers, 2 clients(service), 3 servers(service),
//       4 action clients, 5 action servers
int64_t rb_graph_count(void* node, int kind, const char* name) {
  size_t n = 0;
  rcl_ret_t ret = RCL_RET_ERROR;
  switch (kind) {
    case 0: ret = rcl_count_publishers(node, name, &n); break;
    case 1: ret = rcl_count_subscribers(node, name, &n); break;
#if !defined(RB_DISTRO_HUMBLE)
    case 2: ret = rcl_count_clients(node, name, &n); break;
    case 3: ret = rcl_count_services(node, name, &n); break;
#else
    case 2:
    case 3:
      rb_set_error("counting service clients/servers is not available on Humble");
      return -1;
#endif
#if RB_HAS_SERVICE_ENDPOINT_INFO
    case 4: ret = rcl_action_count_clients(node, name, &n); break;
    case 5: ret = rcl_action_count_servers(node, name, &n); break;
#else
    case 4:
    case 5:
      rb_set_error("counting action clients/servers needs ROS 2 Lyrical or newer");
      return -1;
#endif
  }
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("rcl_count", ret);
    return -1;
  }
  return (int64_t)n;
}

static void js_gid(const uint8_t* gid) {
  js_lit("[");
  for (size_t g = 0; g < RMW_GID_STORAGE_SIZE; g++) {
    if (g) js_lit(",");
    js_int(gid[g]);
  }
  js_lit("]");
}

#if !defined(RB_DISTRO_HUMBLE)
static void js_type_hash(const rosidl_type_hash_t* h) {
  js_lit("[");
  js_int(h->version);
  for (size_t i = 0; i < ROSIDL_TYPE_HASH_SIZE; i++) {
    js_lit(",");
    js_int(h->value[i]);
  }
  js_lit("]");
}
#endif

static void js_topic_endpoint(const rmw_topic_endpoint_info_t* ep) {
  js_lit("{\"nodeName\":");
  js_str(ep->node_name);
  js_lit(",\"nodeNamespace\":");
  js_str(ep->node_namespace);
  js_lit(",\"topicType\":");
  js_str(ep->topic_type);
  js_lit(",\"endpointType\":");
  js_int(ep->endpoint_type);
  js_lit(",\"gid\":");
  js_gid(ep->endpoint_gid);
  js_lit(",\"qos\":");
  js_qos(&ep->qos_profile);
#if !defined(RB_DISTRO_HUMBLE)
  js_lit(",\"typeHash\":");
  js_type_hash(&ep->topic_type_hash);
#endif
  js_lit("}");
}

// kind: 0 publishers, 1 subscriptions
const char* rb_graph_endpoint_info(void* node, int kind, const char* topic, int no_mangle) {
  rcl_allocator_t alloc = rcl_get_default_allocator();
  rcl_topic_endpoint_info_array_t arr = rmw_get_zero_initialized_topic_endpoint_info_array();
  rcl_ret_t ret = kind == 0 ? rcl_get_publishers_info_by_topic(node, &alloc, topic, no_mangle != 0, &arr)
                            : rcl_get_subscriptions_info_by_topic(node, &alloc, topic, no_mangle != 0, &arr);
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("rcl_get_*_info_by_topic", ret);
    return NULL;
  }
  js_reset();
  js_lit("[");
  for (size_t i = 0; i < arr.size; i++) {
    if (i) js_lit(",");
    js_topic_endpoint(&arr.info_array[i]);
  }
  js_lit("]");
  rmw_topic_endpoint_info_array_fini(&arr, &alloc);
  return g_json.buf;
}

#if RB_HAS_SERVICE_ENDPOINT_INFO
// endpoint_count is 2 for DDS (request reader/response writer or the reverse)
// and 1 for middlewares with native services (zenoh)
static void js_service_endpoint(const rmw_service_endpoint_info_t* ep) {
  js_lit("{\"nodeName\":");
  js_str(ep->node_name);
  js_lit(",\"nodeNamespace\":");
  js_str(ep->node_namespace);
  js_lit(",\"serviceType\":");
  js_str(ep->service_type);
  js_lit(",\"typeHash\":");
  js_type_hash(&ep->service_type_hash);
  js_lit(",\"endpointType\":");
  js_int(ep->endpoint_type);
  js_lit(",\"gids\":[");
  for (size_t i = 0; i < ep->endpoint_count; i++) {
    if (i) js_lit(",");
    js_gid(ep->endpoint_gids[i]);
  }
  js_lit("],\"qos\":[");
  for (size_t i = 0; i < ep->endpoint_count; i++) {
    if (i) js_lit(",");
    js_qos(&ep->qos_profiles[i]);
  }
  js_lit("]}");
}
#endif

// kind: 0 clients, 1 servers
const char* rb_graph_service_endpoint_info(void* node, int kind, const char* service, int no_mangle) {
#if RB_HAS_SERVICE_ENDPOINT_INFO
  rcl_allocator_t alloc = rcl_get_default_allocator();
  rcl_service_endpoint_info_array_t arr = rcl_get_zero_initialized_service_endpoint_info_array();
  rcl_ret_t ret = kind == 0 ? rcl_get_clients_info_by_service(node, &alloc, service, no_mangle != 0, &arr)
                            : rcl_get_servers_info_by_service(node, &alloc, service, no_mangle != 0, &arr);
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("rcl_get_*_info_by_service", ret);
    return NULL;
  }
  js_reset();
  js_lit("[");
  for (size_t i = 0; i < arr.size; i++) {
    if (i) js_lit(",");
    js_service_endpoint(&arr.info_array[i]);
  }
  js_lit("]");
  rcl_service_endpoint_info_array_fini(&arr, &alloc);
  return g_json.buf;
#else
  (void)node, (void)kind, (void)service, (void)no_mangle;
  rb_set_error("service endpoint info needs ROS 2 Lyrical or newer");
  return NULL;
#endif
}

// kind: 0 action clients, 1 action servers
const char* rb_graph_action_endpoint_info(void* node, int kind, const char* action) {
#if RB_HAS_ACTION_ENDPOINT_INFO
  rcl_allocator_t alloc = rcl_get_default_allocator();
  rcl_action_endpoint_info_array_t arr = rcl_action_get_zero_initialized_endpoint_info_array();
  rcl_ret_t ret = kind == 0 ? rcl_action_get_clients_info_by_action(node, &alloc, action, &arr)
                            : rcl_action_get_servers_info_by_action(node, &alloc, action, &arr);
  if (ret != RCL_RET_OK) {
    rb_take_rcl_error("rcl_action_get_*_info_by_action", ret);
    return NULL;
  }
  js_reset();
  js_lit("[");
  for (size_t i = 0; i < arr.size; i++) {
    const rcl_action_endpoint_info_t* a = &arr.info_array[i];
    if (i) js_lit(",");
    js_lit("{\"goal\":");
    js_service_endpoint(&a->goal_service_info);
    js_lit(",\"cancel\":");
    js_service_endpoint(&a->cancel_service_info);
    js_lit(",\"result\":");
    js_service_endpoint(&a->result_service_info);
    js_lit(",\"feedback\":");
    js_topic_endpoint(&a->feedback_topic_info);
    js_lit(",\"status\":");
    js_topic_endpoint(&a->status_topic_info);
    js_lit("}");
  }
  js_lit("]");
  rcl_action_endpoint_info_array_fini(&arr, &alloc);
  return g_json.buf;
#else
  (void)node, (void)kind, (void)action;
  rb_set_error("action endpoint info needs ROS 2 Rolling");
  return NULL;
#endif
}

// ---------------------------------------------------------------------------
// misc

const char* rb_rmw_implementation(void) { return rmw_get_implementation_identifier(); }
const char* rb_serialization_format(void) { return rmw_get_serialization_format(); }
