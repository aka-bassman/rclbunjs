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

- Bun ≥ 1.4, Linux (x86_64 or arm64)
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
| Middleware | Fast DDS, Cyclone DDS and Zenoh. With Zenoh, deadline and incompatible-QoS events never fire and content filters are not available; Because of zenoh itself, a process gets slower with every entity it creates and destroys and hangs after about 65,000 of them (eclipse-zenoh/zenoh#2825), and a service client keeps about 0.5 KB per call until the 10-minute query timeout passes (forever for action result requests); a service server also keeps each request until it is answered. rclpy behaves the same. Cyclone DDS over iceoryx shared memory works (see Loaned messages), but processes that start later never learn the names of nodes already running, so the `ros2 node`/`param`/`lifecycle` CLI cannot find them (rclpy nodes alike). On Humble and Jazzy, Fast DDS 2.x keeps about 120 bytes for every DDS reader or writer that ever matched (a publisher or subscription has one, a client or service two), also after it is destroyed, so a process that keeps creating and destroying matched entities grows without bound (about 110 MB after 150,000 rounds of a publisher/subscription pair plus a client/service pair); rclpy grows at least as much. Kilted and newer (Fast DDS 3) do not keep this state, and rclbunjs stays flat there |
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
- Where the memory comes from depends on the middleware. Subscriptions get loans only when the process starts
  with `ROS_DISABLE_LOANED_MESSAGES=0` (rcl's default, all distros).
  - Fast DDS (Jazzy and newer) lends memory to publishers of fixed-size types (`publisher.canLoanMessages`),
    and to subscriptions.
  - Cyclone DDS with iceoryx shared memory (`CYCLONEDDS_URI` with `SharedMemory/Enable`, and `iox-roudi`
    running) lends to publishers and subscriptions on Humble, Jazzy and Kilted.
  - On Lyrical and Rolling (Cyclone DDS 11, `PubSubMessageExchange type="iox"`), rclbunjs uses publisher loans
    only for types without fixed-size arrays and takes no loans, because of rmw_cyclonedds 4.x bugs: a loaned take
    of anything but a raw shared-memory sample aborts the process (e.g. when a publisher goes away; rclcpp aborts
    the same way), and for types with fixed-size arrays it can offer loans that Cyclone then rejects with an
    assertion. Services do not work over shared memory there, with any client library.
  - Humble's Fast DDS, Cyclone DDS without shared memory, and Zenoh lend nothing. The same API then works on a C
    message owned by rclbunjs, published with `rcl_publish` and taken with `rcl_take`, which still skips the
    JavaScript CDR code. Publishers and subscriptions reuse these C messages instead of allocating one per message.
- A borrowed message always starts with the type's default values, whether it was lent or reused.
- Released views are detached, so a view used after its callback throws instead of reading memory that
  went back to the middleware.
- Each view is a new `ArrayBuffer` over the message memory, and Bun's garbage collector counts it as an
  allocation of that size: with 1 MiB messages it collects every few messages (pauses of about 0.5 ms).
  `reuseViews: true`, a publisher or subscription option, keeps one view per message memory instead, so nothing
  is allocated per message. It remembers up to 64 message addresses per publisher or subscription and starts over
  when it sees more, which makes it allocate again if the middleware rotates through more samples than that.
  The price is the safety net above: a view or array used after its callback, `publish` or return is no longer
  caught. It reads or writes whatever that memory holds by then (a later message, or a sample other processes are
  reading). rclbunjs still detaches the views it remembers when it frees their memory and when the publisher or
  subscription is destroyed.

`benchmark/loaned.ts` compares the paths for 1 MiB frames between two processes. All numbers below come from
the same runs: Jazzy in Docker on a 16-core x86_64 Ubuntu host, 1000 frames, two runs per middleware (ranges
are the two runs). Median round trip, and the receiver's time from take to ack in parentheses:

| | CDR path | loaned publish, view receive | loaned on both sides |
|---|---|---|---|
| Fast DDS | 488–489 µs (136–141 µs) | 305–329 µs (42–47 µs) | 274–280 µs (6 µs) |
| Cyclone DDS (no loans) | 671–685 µs (98–108 µs) | 553–570 µs (40–44 µs) | — |
| Cyclone DDS + iceoryx | 310–320 µs (123–129 µs) | 194–216 µs (73–79 µs) | 112–116 µs (4 µs) |

With `reuseViews` on both sides the medians change little and the 90th percentile mostly drops a lot (round
trip, median / 90th percentile):

| | default | `reuseViews` |
|---|---|---|
| Fast DDS, loaned publish, view receive | 305–329 / 632–645 µs | 291–366 / 313–383 µs |
| Fast DDS, loaned on both sides | 274–280 / 622–828 µs | 260–272 / 271–281 µs |
| Cyclone DDS (no loans), C messages on both sides | 553–570 / 997 µs | 552–570 / 643–665 µs |
| Cyclone DDS + iceoryx, loaned publish, view receive | 194–216 / 519–1074 µs | 182–191 / 224–1470 µs |
| Cyclone DDS + iceoryx, loaned on both sides | 112–116 / 471–547 µs | 98–105 / 110–115 µs |

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
git clone https://github.com/aka-bassman/rclbunjs && cd rclbunjs
bun install
bun test test/unit                 # codec & logic tests, no ROS needed
scripts/docker-test.sh             # integration tests in a ROS 2 container (rclpy/ros2 CLI interop)
RMW_IMPLEMENTATION=rmw_cyclonedds_cpp scripts/docker-test.sh
RMW_IMPLEMENTATION=rmw_zenoh_cpp scripts/docker-test.sh       # starts rmw_zenohd in the container
RCLBUN_CYCLONE_SHM=1 scripts/docker-test.sh                    # Cyclone DDS over iceoryx (Linux hosts only: RouDi needs /dev/shm ACLs)
ROS_DISTRO=humble scripts/docker-test.sh                       # humble, jazzy, kilted, lyrical, rolling
bunx tsc --noEmit && bunx tsc --noEmit -p test/types
SOAK_MINUTES=60 scripts/docker-test.sh bun test/soak/soak.ts   # long-running stability / memory trend
scripts/test-matrix.sh jazzy - cc lyrical rmw_zenoh_cpp cc     # several distro/RMW/shim combinations
scripts/docker-test.sh bash -c 'scripts/build-test-msgs.sh && source /tmp/rclbun_test_msgs/install/setup.bash && bun benchmark/loaned.ts'
```

`test/interop/genGolden.py` regenerates the CDR golden vectors with rclpy.

Releases use [Changesets](https://changesets.dev):

```sh
bun run changeset          # describe a change (patch/minor/major); commit the file in .changeset/ with it
bun run version-packages   # apply pending changesets: bump package.json, update CHANGELOG.md
bun run release            # npm publish and a git tag (push it with git push --follow-tags)
```

## License

Apache-2.0. See [NOTICE](NOTICE) for attribution to rclnodejs and ROS 2.
