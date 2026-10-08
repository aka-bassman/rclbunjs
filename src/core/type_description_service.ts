// ~/get_type_description (type_description_interfaces/srv/GetTypeDescription).
// rcl creates the service and answers it from the node's type cache, which
// rcl fills as publishers, subscriptions, services and clients are created.
// Not available on Humble.
import type { Pointer } from "bun:ffi";
import { lib } from "../native/loader.ts";
import { check, checkRc } from "../native/ffi.ts";
import { getServiceType } from "../interfaces/registry.ts";
import { Entity } from "./entity.ts";
import type { Waitable } from "./executor.ts";

export class TypeDescriptionService extends Entity implements Waitable {
  /** @internal */
  constructor(nodeHandle: Pointer) {
    const t = getServiceType("type_description_interfaces/srv/GetTypeDescription");
    super(
      check(lib.rb_type_description_service_init(nodeHandle, t.request.typeSupport(), t.response.typeSupport()), "create type description service"),
      {},
    );
  }

  get serviceName(): string {
    return String(lib.rb_service_name(this.handle));
  }

  /** @internal */
  execute(): void {
    while (!this.isDestroyed() && checkRc(lib.rb_type_description_service_handle(this.handle), "type description request") === 1);
  }

  /** @internal */
  _fini(): void {
    if (this.isDestroyed()) return;
    this.markDestroyed();
    lib.rb_service_fini(this.handle);
  }
}
