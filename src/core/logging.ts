// Logging over rcutils (output goes to console, /rosout and the log file like rclcpp/rclpy).
import { lib } from "../native/loader.ts";
import { cstr, lastError } from "../native/ffi.ts";
import { OperationError } from "./errors.ts";

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

export class Logging {
  static LoggingSeverity = LoggingSeverity;
  readonly name: string;
  #nameC: Uint8Array;

  constructor(name: string) {
    this.name = name;
    this.#nameC = cstr(name);
  }

  static getLogger(name: string): Logging {
    return new Logging(name);
  }

  getChild(name: string): Logging {
    return new Logging(this.name ? `${this.name}.${name}` : name);
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
