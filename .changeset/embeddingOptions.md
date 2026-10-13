---
"rclbunjs": minor
---

Options for running rclbunjs inside a larger application:

- **Breaking:** importing rclbunjs no longer installs a SIGINT handler. Use `init(context, argv, { handleSignals: true })` or `installSignalHandlers()` to get the old behavior (shut down all contexts on Ctrl-C); `removeSignalHandlers()` still removes it.
- The native shim loads on first use (normally `init()`) instead of on import, so the package imports without ROS 2. `isAvailable()` and `loadError()` report whether it loads, without throwing.
- `NodeOptions.onError(error, { kind, name })` receives the errors the executor catches (callback exceptions, failed takes, undecodable messages, wait failures) instead of rethrowing them as uncaught exceptions. `sendRequest` callback errors now go there too.
- Subscription option `maxHz`: drops messages over the rate before decoding them.
- `bunx rclbunjs-build-shim [--out <path>]` prebuilds the shim with the system C compiler (`scripts/build-native.sh` now runs it).
- Type declarations are published as `dist/*.d.ts` instead of pointing at the TypeScript sources.
- `null` message fields encode as their default value, like missing ones, and validation treats them as missing.
