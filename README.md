# rclbunjs

A ROS 2 client library for [Bun](https://bun.sh), written in TypeScript on top of `bun:ffi`.

- **No node-gyp, no N-API, no Python codegen.** A small pointer-only C shim over `rcl` is compiled at
  startup by Bun's built-in TinyCC (or prebuilt with `scripts/build-native.sh`).
- **rclnodejs-shaped API**, so existing rclnodejs code ports with few changes.
- **TypeScript first**: optional generated typings make `createPublisher("geometry_msgs/msg/Twist", …)`
  fully typed.
- Messages cross the FFI boundary as CDR bytes, handled by a built-in codec. Topics use
  `rcl_publish/take_serialized_message`; services use an `rmw_serialize/deserialize` bridge.

Status: early but functional. Interop with rclpy and the `ros2` CLI is tested on ROS 2 Humble, Jazzy, Kilted,
Lyrical and Rolling, with Fast DDS, Cyclone DDS and Zenoh (`rmw_zenoh_cpp`), on x86_64 and arm64.

## Requirements

- Bun ≥ 1.2, Linux (x86_64 or arm64)
- A sourced ROS 2 installation (`source /opt/ros/jazzy/setup.bash`); its headers are used to compile the shim

## Quick start

```ts
import * as rclbun from "rclbunjs"; // or: import rclbun from "rclbunjs"

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
| Topics | publish/subscribe, raw CDR, `MessageInfo`, QoS profiles and custom QoS, `QoSOverridingOptions` (`qos_overrides.*` parameters), typed arrays / `plain` / `json` modes, `waitForMessage`, `createObservableSubscription` (RxJS when installed, async iteration), loaned messages for fixed-size types |
| Services | clients (`sendRequest`, `sendRequestAsync` with timeout/abort, `waitForService`) and services (`response.send` or return value, async handlers); service introspection via `configureIntrospection` (Jazzy+) |
| Actions | `ActionClient` / `ActionServer` (feedback, cancel, result, goal accept/reject), wire-compatible with rclcpp/rclpy |
| Parameters | declare/get/set/undeclare, descriptors (read-only, ranges), on/pre/post-set callbacks, CLI and YAML overrides, `/parameter_events`, the standard parameter services, `ParameterClient`, `ParameterEventHandler`, `ParameterWatcher` |
| Time | `Clock`, `ROSClock`, `Time`, `Duration`, `TimeSource` (`use_sim_time` + `/clock`), clock jump callbacks, `sleepUntil`/`sleepFor`, timers with `TimerInfo` and on-reset callbacks, `Rate` |
| Lifecycle | `LifecycleNode`, the standard state machine and services, `~/transition_event`, lifecycle publishers |
| QoS events | deadline, liveliness, incompatible QoS, incompatible type, matched, message lost |
| Content filter | subscription content filters (Fast DDS) |
| Graph | topic/service/node/action listings (also per node), publisher/subscription/client/service counts, topic endpoint info with QoS and type hash; service endpoint info and action client/server counts (Lyrical+); action endpoint info (Rolling) |
| Validation | `validateMessage` / `assertValidMessage` / `createMessageValidator`, `getMessageSchema`, `getFieldNames`, `getFieldType`; `validator` for topic/node/namespace names |
| Utilities | `DistroUtils`, `RMWUtils`, `features` (optional rcl features of the installed distro) |
| Middleware | Fast DDS, Cyclone DDS and Zenoh. With Zenoh, deadline and incompatible-QoS events never fire and content filters are not available; rmw_zenoh also gets slower with every entity created and destroyed in a process (about +4 ms per create/destroy cycle per 1000 cycles), keeps a service request until it is answered, and its memory grows with service calls (about 0.5 KB per call over the first 100k); rclpy behaves the same |
| Type descriptions | `~/get_type_description` served from rcl's type cache (Jazzy+), gated by `start_type_description_service` |
| Logging | rcutils logging (console, `/rosout` with configurable `rosoutQos`, log files), logger levels, `~/get_logger_levels` / `~/set_logger_levels` (`enableLoggerService`) |

## Messages

Messages are plain objects. Missing fields get their default values.

- `int64`/`uint64` become `bigint`.
- Numeric arrays decode to TypedArrays. Choose `serializationMode: "plain"` to get plain arrays instead.
- As in rclnodejs, a bare value stands for the `data` field: `pub.publish("hello")` on a `std_msgs/msg/String` topic.
- `{ validateMessages: true }` (publishers) and `{ validateRequests: true }` (clients) check messages against the
  interface definition before sending, with field-level errors.

Interface definitions are discovered at runtime through `AMENT_PREFIX_PATH`, so custom packages from an
overlay workspace work as soon as the workspace is sourced.

```ts
const msg = rclbun.createMessageObject("sensor_msgs/msg/JointState"); // defaults filled in
const bytes = rclbun.serializeMessage({ data: "x" }, "std_msgs/msg/String"); // CDR
```

The codec compiles each message type into straight-line JavaScript. For large numeric arrays (images, point
clouds, scans), `deserializeMessage(bytes, type, { zeroCopy: true })` and the subscription option
`{ zeroCopy: true }` return the arrays as views into one buffer per message instead of separate copies
(`array.buffer` is then the whole message). `bun benchmark/codec.ts` measures the codec without ROS.

## Loaned messages

For fixed-size message types (no strings or sequences), a publisher can lend you the message memory: you
write the fields in place and publish without serializing in JavaScript. Subscriptions can receive the
same kind of view instead of a decoded object.

```ts
const pub = node.createPublisher("my_msgs/msg/Frame", "frames"); // e.g. uint8[1048576] data
const loan = pub.borrowLoanedMessage();
loan.message.seq = 1n;
camera.readInto(loan.message.data); // a Uint8Array over the loaned memory
pub.publish(loan); // loan.message is unusable afterwards

node.createSubscription("my_msgs/msg/Frame", "frames", { loanedMessages: true }, (frame) => {
  process(frame.data); // valid only during the callback; frame.toObject() makes a copy
});
```

- Numeric arrays are TypedArrays over the message memory, including `int64`/`uint64` (`BigInt64Array`) and
  `bool` (`Uint8Array`) arrays. `msg.set({...})` assigns nested fields; `msg.toObject()` copies out.
- Where the memory comes from depends on the middleware:
  - Fast DDS (Jazzy and newer) lends memory to publishers of fixed-size types (`publisher.canLoanMessages`).
    It lends to subscriptions only when the process starts with `ROS_DISABLE_LOANED_MESSAGES=0`.
  - Humble's Fast DDS, Cyclone DDS (without shared memory) and Zenoh lend nothing. The same API then works on a C message
    owned by rclbunjs, published with `rcl_publish` and taken with `rcl_take`, which still skips the
    JavaScript CDR code.
- Released views are detached, so a view used after its callback throws instead of reading memory that
  went back to the middleware.

`benchmark/loaned.ts` compares the paths for 1 MiB frames between two processes (median round trip, and
the receiver's time from take to ack in parentheses):

| | CDR path | loaned publish, view receive | loaned on both sides |
|---|---|---|---|
| Fast DDS, arm64 (Docker Desktop) | 1189 µs (83 µs) | 391 µs (29 µs) | 350 µs (7 µs) |
| Fast DDS, x86_64 (Ryzen 7 5700U) | 2395 µs (550 µs) | 1106 µs (201 µs) | 766 µs (25 µs) |
| Cyclone DDS (no loans), arm64 | 1144 µs (62 µs) | 470 µs (27 µs) | — |
| Cyclone DDS (no loans), x86_64 | 2352 µs (334 µs) | 1770 µs (178 µs) | — |

## Typed messages

Generate declarations for the interfaces installed in your environment:

```sh
bunx rclbunjs-typegen --out rclbunjs-interfaces.d.ts      # all packages
bunx rclbunjs-typegen --packages my_msgs,geometry_msgs     # a subset
```

Then include the generated file in your `tsconfig.json`. Message, request, response, goal and feedback types
are inferred from the type name string.

- The comments of the `.msg`/`.srv`/`.action` files become JSDoc on the interfaces and fields, grouped the way
  rosidl does it (the same text it writes into the generated `.idl`; a `[unit]` in a field comment becomes
  `Unit:`), with default values (`@default`) and array bounds. Interfaces that only have an `.idl` file get their
  `@verbatim` comments and `@unit` annotations.
- Constants get literal types. As in rclnodejs, they are properties of `require()` results:

  ```ts
  const GoalStatus = rclbun.require("action_msgs/msg/GoalStatus");
  if (status === GoalStatus.STATUS_SUCCEEDED) { /* typed as 4 */ }
  ```

## Differences from rclnodejs

- `node.spin()` is non-blocking and needs no timeout. Each node has a background thread that waits in `rcl_wait`
  and wakes Bun's event loop.
- Typing comes from generated declaration maps rather than generated JS classes. `rclbun.require(name)` returns a
  type descriptor (`encode`/`decode`/`create`) instead of a class.
- Actions and lifecycle are implemented in TypeScript over plain services and topics. They are wire-compatible with
  rcl_action and rcl_lifecycle, including remapping of action names.
- `int64` arrays decode to `bigint[]`. Other numeric arrays decode to TypedArrays.

## Development

```sh
bun install
bun test test/unit                 # codec & logic tests, no ROS needed
scripts/docker-test.sh             # integration tests in a ROS 2 container (rclpy/ros2 CLI interop)
RMW_IMPLEMENTATION=rmw_cyclonedds_cpp scripts/docker-test.sh
RMW_IMPLEMENTATION=rmw_zenoh_cpp scripts/docker-test.sh       # starts rmw_zenohd in the container
ROS_DISTRO=humble scripts/docker-test.sh                       # humble, jazzy, kilted, lyrical, rolling
bunx tsc --noEmit && bunx tsc --noEmit -p test/types
SOAK_MINUTES=60 scripts/docker-test.sh bun test/soak/soak.ts   # long-running stability / memory trend
scripts/test-matrix.sh jazzy - cc lyrical rmw_zenoh_cpp cc     # several distro/RMW/shim combinations
scripts/docker-test.sh bash -c 'scripts/build-test-msgs.sh && source /tmp/rclbun_test_msgs/install/setup.bash && bun benchmark/loaned.ts'
```

`test/interop/gen_golden.py` regenerates the CDR golden vectors with rclpy.

CI (`.github/workflows/ci.yml`) runs the unit tests and type checks, then the integration suite for Humble, Jazzy,
Kilted, Lyrical and Rolling on x64 and arm64 (plus Jazzy with Cyclone DDS, and Jazzy and Lyrical with Zenoh), both
with the runtime-compiled shim and with the prebuilt one.

## License

Apache-2.0. See [NOTICE](NOTICE) for attribution to rclnodejs and ROS 2.
