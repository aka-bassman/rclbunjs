import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as rclbun from "../../src/index.ts";
import { ServiceIntrospectionStates } from "../../src/index.ts";
import { features } from "../../src/native/loader.ts";

let node: rclbun.Node;
beforeAll(async () => {
  await rclbun.init();
  node = rclbun.createNode("introspection_test");
  node.spin();
});
afterAll(() => rclbun.shutdown());

const until = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await Bun.sleep(5);
  return cond();
};

// service_msgs/msg/ServiceEventInfo
const REQUEST_SENT = 0;
const REQUEST_RECEIVED = 1;
const RESPONSE_SENT = 2;
const RESPONSE_RECEIVED = 3;

describe.skipIf(!features.serviceIntrospection)("service introspection", () => {
  test("CONTENTS and METADATA events on <service>/_service_event", async () => {
    const srv = node.createService("example_interfaces/srv/AddTwoInts", "introspected_add", (req: any) => ({ sum: req.a + req.b }));
    const client = node.createClient("example_interfaces/srv/AddTwoInts", "introspected_add");
    srv.configureIntrospection(node.getClock(), rclbun.QoS.profileSystemDefault, ServiceIntrospectionStates.CONTENTS);
    client.configureIntrospection(node.getClock(), rclbun.QoS.profileSystemDefault, ServiceIntrospectionStates.CONTENTS);

    const events: any[] = [];
    const sub = node.createSubscription("example_interfaces/srv/AddTwoInts_Event", "introspected_add/_service_event", (e: any) => events.push(e));
    expect(await until(() => sub.publisherCount >= 2)).toBe(true);
    expect(await client.waitForService(5000)).toBe(true);

    expect((await client.sendRequestAsync({ a: 2n, b: 3n }, { timeout: 5000 })).sum).toBe(5n);
    expect(await until(() => events.length >= 4)).toBe(true);
    const byType = new Map(events.map((e) => [e.info.event_type, e]));
    expect([...byType.keys()].sort()).toEqual([REQUEST_SENT, REQUEST_RECEIVED, RESPONSE_SENT, RESPONSE_RECEIVED]);
    expect(byType.get(REQUEST_RECEIVED).request[0].a).toBe(2n);
    expect(byType.get(RESPONSE_RECEIVED).response[0].sum).toBe(5n);
    expect(byType.get(REQUEST_SENT).info.sequence_number).toBe(byType.get(RESPONSE_RECEIVED).info.sequence_number);

    events.length = 0;
    srv.configureIntrospection(node.getClock(), rclbun.QoS.profileSystemDefault, ServiceIntrospectionStates.METADATA);
    client.configureIntrospection(node.getClock(), rclbun.QoS.profileSystemDefault, ServiceIntrospectionStates.METADATA);
    await client.sendRequestAsync({ a: 1n, b: 1n }, { timeout: 5000 });
    expect(await until(() => events.length >= 4)).toBe(true);
    for (const e of events) {
      expect(e.request).toHaveLength(0);
      expect(e.response).toHaveLength(0);
    }

    events.length = 0;
    srv.configureIntrospection(node.getClock(), rclbun.QoS.profileSystemDefault, ServiceIntrospectionStates.OFF);
    client.configureIntrospection(node.getClock(), rclbun.QoS.profileSystemDefault, ServiceIntrospectionStates.OFF);
    await client.sendRequestAsync({ a: 1n, b: 1n }, { timeout: 5000 });
    await Bun.sleep(200);
    expect(events).toHaveLength(0);

    node.destroySubscription(sub);
    node.destroyClient(client);
    node.destroyService(srv);
  }, 20000);
});

describe.skipIf(!features.typeDescriptionService)("type description service", () => {
  test("~/get_type_description answers for types the node uses", async () => {
    expect(node.getParameter("start_type_description_service").value).toBe(true);
    const pub = node.createPublisher("geometry_msgs/msg/Twist", "td_twist");
    const info = node.getPublishersInfoByTopic("td_twist");
    expect(info).toHaveLength(1);
    const hash = info[0]!.topic_type_hash!;
    expect(hash.version).toBe(1);
    const typeHash = `RIHS01_${hash.value.toString("hex")}`;

    const client = node.createClient("type_description_interfaces/srv/GetTypeDescription", "/introspection_test/get_type_description");
    expect(await client.waitForService(5000)).toBe(true);
    const resp: any = await client.sendRequestAsync({ type_name: "geometry_msgs/msg/Twist", type_hash: typeHash, include_type_sources: true }, { timeout: 5000 });
    expect(resp.successful).toBe(true);
    expect(resp.type_description.type_description.type_name).toBe("geometry_msgs/msg/Twist");
    expect(resp.type_description.type_description.fields.map((f: any) => f.name)).toEqual(["linear", "angular"]);
    expect(resp.type_description.referenced_type_descriptions.map((t: any) => t.type_name)).toContain("geometry_msgs/msg/Vector3");
    expect(resp.type_sources.length).toBeGreaterThan(0);

    const bad: any = await client.sendRequestAsync({ type_name: "geometry_msgs/msg/Twist", type_hash: "RIHS01_" + "00".repeat(32) }, { timeout: 5000 });
    expect(bad.successful).toBe(false);
    node.destroyClient(client);
    node.destroyPublisher(pub);
  }, 20000);

  test("disabled by the start_type_description_service parameter", async () => {
    const n = rclbun.createNode("td_disabled", "", undefined, {
      parameterOverrides: [new rclbun.Parameter("start_type_description_service", rclbun.ParameterType.PARAMETER_BOOL, false)],
    });
    expect(n.getServiceNamesAndTypesByNode("td_disabled").map((s) => s.name)).not.toContain("/td_disabled/get_type_description");
    const m = rclbun.createNode("td_enabled");
    expect(
      await until(() => node.getServiceNamesAndTypesByNode("td_enabled").some((s) => s.name === "/td_enabled/get_type_description")),
    ).toBe(true);
    n.destroy();
    m.destroy();
  });
});
