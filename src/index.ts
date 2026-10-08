// rclbunjs entry point. The type maps live here so generated declarations can
// augment them with `declare module "rclbunjs"`; everything else is in api.ts.

/** Message types by name; filled in by `bunx rclbunjs-typegen` (declaration merging). */
// biome-ignore lint/suspicious/noEmptyInterface: augmented by generated declarations
export interface MessageTypeMap {}
/** Service types by name: { Request, Response }. */
// biome-ignore lint/suspicious/noEmptyInterface: augmented by generated declarations
export interface ServiceTypeMap {}
/** Action types by name: { Goal, Result, Feedback }. */
// biome-ignore lint/suspicious/noEmptyInterface: augmented by generated declarations
export interface ActionTypeMap {}
export * from "./api.ts";

// Default export: the whole API object, so `import rclbun from "rclbunjs"`
// works like `const rclnodejs = require("rclnodejs")`.
import * as api from "./api.ts";
export default api;
