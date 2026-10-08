# rclbunjs

A ROS 2 client library for [Bun](https://bun.sh), written in TypeScript on top of `bun:ffi`.

- **No node-gyp, no N-API, no Python codegen.** A small pointer-only C shim over `rcl` is compiled at
  startup by Bun's built-in TinyCC (or prebuilt with `scripts/build-native.sh`).
- **rclnodejs-shaped API**, so existing rclnodejs code ports with few changes.
- **TypeScript first**: optional generated typings make `createPublisher("geometry_msgs/msg/Twist", …)`
  fully typed.
- Messages cross the FFI boundary as CDR bytes, handled by a built-in codec. Topics use
  `rcl_publish/take_serialized_message`; services use an `rmw_serialize/deserialize` bridge.

Status: early but functional. Interop with rclpy and the `ros2` CLI is tested on ROS 2 Jazzy
(Fast DDS and Cyclone DDS).

## Requirements

- Bun ≥ 1.2, Linux (x86_64 or arm64)
- A sourced ROS 2 installation (`source /opt/ros/jazzy/setup.bash`); its headers are used to compile the shim

## Quick start

```ts
import * as rclbun from "rclbunjs";

await rclbun.init();
const node = rclbun.createNode("talker");
const pub = node.createPublisher("std_msgs/msg/String", "chatter");
node.createSubscription("std_msgs/msg/String", "chatter", (msg) => console.log(msg.data));
node.createTimer(500_000_000n, () => pub.publish({ data: "hello from bun" }));
node.spin(); // non-blocking: callbacks run on Bun's event loop
```

More examples are in [`examples/`](examples): talker/listener, a service, an action, parameters and a lifecycle node.

## Features

| Area | Supported |
|---|---|
| Context/Node | `init(argv)` with `--ros-args` (remapping, `-p`, `--params-file`), namespaces, domain id, node args |
| Topics | publish/subscribe, raw CDR, `MessageInfo`, QoS profiles and custom QoS, typed arrays / `plain` / `json` modes |
| Services | clients (`sendRequest`, `sendRequestAsync` with timeout/abort, `waitForService`) and services (`response.send` or return value, async handlers); service introspection via `configureIntrospection` (Jazzy+) |
| Actions | `ActionClient` / `ActionServer` (feedback, cancel, result, goal accept/reject), wire-compatible with rclcpp/rclpy |
| Parameters | declare/get/set/undeclare, descriptors (read-only, ranges), on/pre/post-set callbacks, CLI and YAML overrides, `/parameter_events`, the standard parameter services, `ParameterClient`, `ParameterEventHandler`, `ParameterWatcher` |
| Time | `Clock`, `ROSClock`, `Time`, `Duration`, `TimeSource` (`use_sim_time` + `/clock`), clock jump callbacks, `sleepUntil`/`sleepFor`, timers with `TimerInfo` and on-reset callbacks, `Rate` |
| Lifecycle | `LifecycleNode`, the standard state machine and services, `~/transition_event`, lifecycle publishers |
| QoS events | deadline, liveliness, incompatible QoS, incompatible type, matched, message lost |
| Content filter | subscription content filters (Fast DDS) |
| Graph | topic/service/node listings, publisher/subscription counts, endpoint info with QoS and type hash |
| Type descriptions | `~/get_type_description` served from rcl's type cache (Jazzy+), gated by `start_type_description_service` |
| Logging | rcutils logging (console, `/rosout`, log files), logger levels |

## Messages

Messages are plain objects. Missing fields get their default values.

- `int64`/`uint64` become `bigint`.
- Numeric arrays decode to TypedArrays. Choose `serializationMode: "plain"` to get plain arrays instead.

Interface definitions are discovered at runtime through `AMENT_PREFIX_PATH`, so custom packages from an
overlay workspace work as soon as the workspace is sourced.

```ts
const msg = rclbun.createMessageObject("sensor_msgs/msg/JointState"); // defaults filled in
const bytes = rclbun.serializeMessage({ data: "x" }, "std_msgs/msg/String"); // CDR
```

## Typed messages

Generate declarations for the interfaces installed in your environment:

```sh
bunx rclbunjs-typegen --out rclbunjs-interfaces.d.ts      # all packages
bunx rclbunjs-typegen --packages my_msgs,geometry_msgs     # a subset
```

Then include the generated file in your `tsconfig.json`. Message, request, response, goal and feedback types
are inferred from the type name string.

## Differences from rclnodejs

- `node.spin()` is non-blocking and needs no timeout. Each node has a background thread that waits in `rcl_wait`
  and wakes Bun's event loop.
- Typing comes from generated declaration maps rather than generated JS classes. `rclbun.require(name)` returns a
  type descriptor (`encode`/`decode`/`create`) instead of a class.
- Actions and lifecycle are implemented in TypeScript over plain services and topics. They are wire-compatible with
  rcl_action and rcl_lifecycle. One difference: remapping rules apply to the underlying `/_action/*` service and
  topic names, not to the action name itself.
- `int64` arrays decode to `bigint[]`. Other numeric arrays decode to TypedArrays.

## Development

```sh
bun install
bun test test/unit                 # codec & logic tests, no ROS needed
scripts/docker-test.sh             # integration tests in a ROS 2 container (rclpy/ros2 CLI interop)
RMW_IMPLEMENTATION=rmw_cyclonedds_cpp scripts/docker-test.sh
ROS_DISTRO=humble scripts/docker-test.sh
bunx tsc --noEmit && bunx tsc --noEmit -p test/types
```

`test/interop/gen_golden.py` regenerates the CDR golden vectors with rclpy.

## License

Apache-2.0. See [NOTICE](NOTICE) for attribution to rclnodejs and ROS 2.
