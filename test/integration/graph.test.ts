import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as rclbun from "../../src/index.ts";
import { features } from "../../src/index.ts";

// Graph queries that need a newer distro than Kilted: service endpoint info and
// action counts (Lyrical), action endpoint info (Rolling).

let node: rclbun.Node;
let other: rclbun.Node;
beforeAll(async () => {
  await rclbun.init();
  node = rclbun.createNode("graph_test");
  other = rclbun.createNode("graph_peer", "/peer");
  node.spin();
  other.spin();
});
afterAll(() => rclbun.shutdown());

const until = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await Bun.sleep(20);
  return cond();
};

const ADD = "example_interfaces/srv/AddTwoInts";
const FIB = "example_interfaces/action/Fibonacci";
// one endpoint per service for middlewares with native services, else request + response topics
const perService = process.env.RMW_IMPLEMENTATION === "rmw_zenoh_cpp" ? 1 : 2;

test.skipIf(features.serviceEndpointInfo)("older distros return null", () => {
  expect(node.getClientsInfoByService("/x")).toBeNull();
  expect(node.getServersInfoByService("/x")).toBeNull();
  expect(node.countActionClients("/x")).toBeNull();
  expect(node.countActionServers("/x")).toBeNull();
});

test.skipIf(features.actionEndpointInfo)("action endpoint info returns null before Rolling", () => {
  expect(node.getActionClientsInfoByAction("/x")).toBeNull();
  expect(node.getActionServersInfoByAction("/x")).toBeNull();
});

describe.skipIf(!features.serviceEndpointInfo)("service endpoint info (Lyrical+)", () => {
  test("clients and servers with node, type, gids and QoS", async () => {
    const srv = other.createService(ADD, "graph_add", (req: any) => ({ sum: req.a + req.b }));
    const cli = node.createClient(ADD, "/peer/graph_add");
    expect(await until(() => (node.getServersInfoByService("/peer/graph_add")?.length ?? 0) === 1)).toBe(true);
    expect(await until(() => (node.getClientsInfoByService("/peer/graph_add")?.length ?? 0) === 1)).toBe(true);

    const [server] = node.getServersInfoByService("/peer/graph_add")!;
    expect(server!.node_name).toBe("graph_peer");
    expect(server!.node_namespace).toBe("/peer");
    expect(server!.service_type).toBe(ADD);
    expect(server!.endpoint_type).toBe(4); // RMW_ENDPOINT_SERVER
    expect(server!.endpoint_count).toBe(perService);
    expect(server!.endpoint_gids).toHaveLength(perService);
    expect(server!.qos_profiles).toHaveLength(perService);
    expect(server!.qos_profiles[0]).toBeInstanceOf(rclbun.QoS);
    expect(server!.service_type_hash.version).toBe(1);
    expect(server!.service_type_hash.value).toHaveLength(32);

    const [client] = node.getClientsInfoByService("/peer/graph_add")!;
    expect(client!.node_name).toBe("graph_test");
    expect(client!.endpoint_type).toBe(3); // RMW_ENDPOINT_CLIENT
    expect(client!.service_type_hash.value.equals(server!.service_type_hash.value)).toBe(true);
    // relative names resolve against the querying node
    expect(other.getServersInfoByService("graph_add")).toHaveLength(1);

    node.destroyClient(cli);
    other.destroyService(srv);
    expect(await until(() => node.getServersInfoByService("/peer/graph_add")!.length === 0)).toBe(true);
  });

  test("countActionClients / countActionServers", async () => {
    expect(node.countActionServers("/graph_fib")).toBe(0);
    const server = new rclbun.ActionServer(other, FIB, "/graph_fib", async (gh) => {
      gh.succeed();
      return { sequence: [] };
    });
    const client = new rclbun.ActionClient(node, FIB, "/graph_fib");
    expect(await until(() => node.countActionServers("/graph_fib") === 1)).toBe(true);
    expect(await until(() => node.countActionClients("/graph_fib") === 1)).toBe(true);
    client.destroy();
    server.destroy();
    expect(await until(() => node.countActionServers("/graph_fib") === 0 && node.countActionClients("/graph_fib") === 0)).toBe(true);
  });
});

describe.skipIf(!features.actionEndpointInfo)("action endpoint info (Rolling)", () => {
  test("servers and clients with their service and topic endpoints", async () => {
    const server = new rclbun.ActionServer(other, FIB, "graph_fib2", async (gh) => {
      gh.succeed();
      return { sequence: [] };
    });
    const client = new rclbun.ActionClient(node, FIB, "/peer/graph_fib2");
    expect(await until(() => (node.getActionServersInfoByAction("/peer/graph_fib2")?.length ?? 0) === 1)).toBe(true);
    expect(await until(() => (node.getActionClientsInfoByAction("/peer/graph_fib2")?.length ?? 0) === 1)).toBe(true);

    const [s] = node.getActionServersInfoByAction("/peer/graph_fib2")!;
    expect(s).toBeInstanceOf(rclbun.ActionEndpointInfo);
    expect(s!.nodeName).toBe("graph_peer");
    expect(s!.nodeNamespace).toBe("/peer");
    expect(s!.actionType).toBe(FIB);
    expect(s!.endpointType).toBe(4); // server
    expect(s!.goalServiceInfo.service_type).toBe(`${FIB}_SendGoal`);
    expect(s!.cancelServiceInfo.service_type).toBe("action_msgs/srv/CancelGoal");
    expect(s!.resultServiceInfo.service_type).toBe(`${FIB}_GetResult`);
    expect(s!.feedbackTopicInfo.topic_type).toBe(`${FIB}_FeedbackMessage`);
    expect(s!.statusTopicInfo.topic_type).toBe("action_msgs/msg/GoalStatusArray");
    expect(s!.feedbackTopicInfo.endpoint_type).toBe(1); // publisher

    const [c] = node.getActionClientsInfoByAction("/peer/graph_fib2")!;
    expect(c!.nodeName).toBe("graph_test");
    expect(c!.endpointType).toBe(3); // client
    expect(c!.feedbackTopicInfo.endpoint_type).toBe(2); // subscription
    client.destroy();
    server.destroy();
  });
});
