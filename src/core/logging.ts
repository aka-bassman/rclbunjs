// Logging over rcutils (output goes to console, /rosout and the log file like rclcpp/rclpy).
import { lib } from "../native/loader.ts";
import { cstr, lastError } from "../native/ffi.ts";
import { OperationError, TypeValidationError } from "./errors.ts";

export enum LoggingSeverity {
  UNSET = 0,
  DEBUG = 10,
  INFO = 20,
  WARN = 30,
  ERROR = 40,
  FATAL = 50,
}

// Only pay for stack inspection when the console format asks for caller info.
const WANT_CALLER = /\{(file_name|function_name|line_number)\}/.test(process.env.RCUTILS_CONSOLE_OUTPUT_FORMAT ?? "");

function caller(): { file: string; fn: string; line: number } {
  const stack = new Error().stack?.split("\n") ?? [];
  // [0] "Error", [1] caller(), [2] Logging.#log, [3] Logging.info, [4] user
  const frame = stack[4] ?? "";
  const m = /at (?:(.*?) \()?(.*?):(\d+):\d+\)?$/.exec(frame.trim());
  return m ? { fn: m[1] ?? "<anonymous>", file: m[2] ?? "", line: Number(m[3]) } : { fn: "", file: "", line: 0 };
}

// node logger name -> sublogger name -> active registrations (rcl refcounts them too)
const subloggers = new Map<string, Map<string, number>>();

export class Logging {
  static LoggingSeverity = LoggingSeverity;
  readonly name: string;
  #nameC: Uint8Array;
  #sublogger: { parent: string; sub: string } | undefined;

  constructor(name: string) {
    this.name = name;
    this.#nameC = cstr(name);
  }

  static getLogger(name: string): Logging {
    return new Logging(name);
  }

  /**
   * A child logger (`<name>.<child>`). Children of a node's logger also
   * publish to /rosout (Iron and newer); call destroy() when done with one.
   */
  getChild(name: string): Logging {
    if (typeof name !== "string" || !name) throw new TypeValidationError("child logger name must be a non-empty string");
    const child = new Logging(this.name ? `${this.name}.${name}` : name);
    if (this.name && lib.rb_logging_add_sublogger(this.#nameC, cstr(name)) === 1) {
      const subs = subloggers.get(this.name) ?? new Map<string, number>();
      subs.set(name, (subs.get(name) ?? 0) + 1);
      subloggers.set(this.name, subs);
      child.#sublogger = { parent: this.name, sub: name };
    }
    return child;
  }

  /** Unregisters a child logger from /rosout (no-op for other loggers). */
  destroy(): void {
    const s = this.#sublogger;
    if (!s) return;
    this.#sublogger = undefined;
    const subs = subloggers.get(s.parent);
    const n = subs?.get(s.sub) ?? 0;
    if (n === 0) return; // already released with its node
    if (n === 1) subs!.delete(s.sub);
    else subs!.set(s.sub, n - 1);
    lib.rb_logging_remove_sublogger(cstr(s.parent), cstr(s.sub));
  }

  /**
   * @internal rcl requires subloggers to be removed while the node's rosout
   * publisher still exists, so a node releases its children before finishing.
   */
  static _releaseSubloggers(parent: string): void {
    const subs = subloggers.get(parent);
    if (!subs) return;
    subloggers.delete(parent);
    for (const [sub, n] of subs) for (let i = 0; i < n; i++) lib.rb_logging_remove_sublogger(cstr(parent), cstr(sub));
  }

  get LoggingSeverity() {
    return LoggingSeverity;
  }

  setLoggerLevel(level: LoggingSeverity): void {
    if (lib.rb_logging_set_level(this.#nameC, level) !== 0) {
      throw new OperationError(`cannot set level ${level} for logger '${this.name}': ${lastError()}`);
    }
  }

  /** The level set on this logger itself (UNSET if it inherits one). */
  get loggerLevel(): LoggingSeverity {
    return lib.rb_logging_get_level(this.#nameC);
  }

  get loggerEffectiveLevel(): LoggingSeverity {
    return lib.rb_logging_get_effective_level(this.#nameC);
  }

  isEnabledFor(level: LoggingSeverity): boolean {
    return lib.rb_logging_is_enabled_for(this.#nameC, level) === 1;
  }

  #log(severity: LoggingSeverity, message: unknown): boolean {
    if (lib.rb_logging_is_enabled_for(this.#nameC, severity) !== 1) return false;
    const c = WANT_CALLER ? caller() : { file: "", fn: "", line: 0 };
    return lib.rb_log(this.#nameC, severity, cstr(c.file), cstr(c.fn), BigInt(c.line), cstr(String(message))) === 1;
  }

  debug(message: unknown): boolean { return this.#log(LoggingSeverity.DEBUG, message); }
  info(message: unknown): boolean { return this.#log(LoggingSeverity.INFO, message); }
  warn(message: unknown): boolean { return this.#log(LoggingSeverity.WARN, message); }
  error(message: unknown): boolean { return this.#log(LoggingSeverity.ERROR, message); }
  fatal(message: unknown): boolean { return this.#log(LoggingSeverity.FATAL, message); }
}
