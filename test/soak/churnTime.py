# Same churn cycle as churnTime.ts, with rclpy.
#   RMW_IMPLEMENTATION=rmw_zenoh_cpp scripts/docker-test.sh python3 test/soak/churnTime.py
import os, time, rclpy
from std_msgs.msg import String
from std_srvs.srv import Trigger
rclpy.init()
node = rclpy.create_node("churn_time_py")
N = int(os.environ.get("SOAK_CYCLES", "6000"))
def rss():
    with open("/proc/self/status") as f:
        for l in f:
            if l.startswith("VmRSS"): return int(l.split()[1]) // 1024
t = time.perf_counter()
for i in range(1, N + 1):
    s = node.create_subscription(String, f"ct/t{i % 7}", lambda m: None, 10)
    p = node.create_publisher(String, f"ct/t{i % 7}", 10)
    c = node.create_client(Trigger, f"ct/s{i % 5}")
    v = node.create_service(Trigger, f"ct/s{i % 5}", lambda req, res: res)
    node.destroy_service(v); node.destroy_client(c); node.destroy_publisher(p); node.destroy_subscription(s)
    if i % 20 == 0:
        n = rclpy.create_node(f"ct_tmp_{i % 3}"); n.create_subscription(String, "ct/tmp", lambda m: None, 10); n.destroy_node()
    if i % 500 == 0:
        rclpy.spin_once(node, timeout_sec=0.001)
        now = time.perf_counter()
        print(f"py cycles={i} ms/cycle={(now - t) / 500 * 1000:.2f} rssMB={rss()}", flush=True)
        t = time.perf_counter()
rclpy.shutdown()
