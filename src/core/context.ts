// Context: owns an rcl_context_t and the nodes created in it.
import type { Pointer } from "bun:ffi";
import { lib } from "../native/loader.ts";
import { check, cstrArray, json } from "../native/ffi.ts";
import { OperationError } from "./errors.ts";

interface NodeLike {
  destroy(): void;
}

export class Context {
  static #default: Context | undefined;
  static #instances = new Set<Context>();

  /** @internal */
  handle: Pointer | null = null;
  #nodes = new Set<NodeLike>();
  #domainId: bigint | undefined;
  #argv: string[] = [];
  #shutdown = false;

  constructor(domainId?: bigint) {
    this.#domainId = domainId;
    Context.#instances.add(this);
  }

  static defaultContext(): Context {
    if (!Context.#default || Context.#default.#shutdown) Context.#default = new Context();
    return Context.#default;
  }

  static get instances(): Context[] {
    return [...Context.#instances];
  }

  /** @internal */
  init(argv: string[]): void {
    if (this.handle) throw new OperationError("The context has already been initialized");
    const a = cstrArray(argv);
    this.handle = check(lib.rb_context_init(a.argc, a.argv, this.#domainId ?? -1n), "rcl_init");
    void a.keep;
    this.#argv = argv;
    this.#shutdown = false;
  }

  isUninitialized(): boolean {
    return this.handle === null && !this.#shutdown;
  }

  isInitialized(): boolean {
    return this.handle !== null && lib.rb_context_is_valid(this.handle) === 1;
  }

  /** True while initialized and not shut down. */
  isValid(): boolean {
    return this.isInitialized();
  }

  get isOk(): boolean {
    return this.isValid();
  }

  isShutdown(): boolean {
    return this.#shutdown || (this.handle !== null && lib.rb_context_is_valid(this.handle) !== 1);
  }

  isDefaultContext(): boolean {
    return this === Context.#default;
  }

  get nodes(): NodeLike[] {
    return [...this.#nodes];
  }

  get domainId(): bigint {
    if (!this.handle) return this.#domainId ?? 0n;
    return lib.rb_context_domain_id(this.handle);
  }

  /** Arguments that rcl did not consume as ROS arguments. */
  get unparsedArguments(): string[] {
    if (!this.handle) return [];
    const a = cstrArray(this.#argv);
    const out = json<string[]>(lib.rb_context_unparsed_args(this.handle, a.argc, a.argv), "unparsed args");
    void a.keep;
    return out;
  }

  /** @internal */
  addNode(n: NodeLike): void {
    this.#nodes.add(n);
  }

  /** @internal */
  removeNode(n: NodeLike): void {
    this.#nodes.delete(n);
  }

  shutdown(): void {
    if (!this.handle) {
      this.#shutdown = true;
      return;
    }
    for (const n of [...this.#nodes]) n.destroy();
    this.#nodes.clear();
    lib.rb_context_shutdown(this.handle);
    lib.rb_context_fini(this.handle);
    this.handle = null;
    this.#shutdown = true;
    Context.#instances.delete(this);
  }

  tryShutdown(): void {
    if (this.handle) this.shutdown();
  }
}
