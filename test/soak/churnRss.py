# rclpy counterpart of churnRss.ts (RSS growth per round of create + destroy).
#   RMW_IMPLEMENTATION=rmw_cyclonedds_cpp scripts/docker-test.sh python3 test/soak/churnRss.py
import gc, time, rclpy
from std_srvs.srv import Trigger

def rss_mb():
    with open("/proc/self/status") as f:
        for l in f:
            if l.startswith("VmRSS"):
                return int(l.split()[1]) / 1024

rclpy.init()
node = rclpy.create_node("churn_py")
def kind(name, n, fn):
    for i in range(100): fn(i)
    out = []
    for r in range(3):
        gc.collect(); time.sleep(0.5); r0 = rss_mb()
        for i in range(n): fn(i)
        gc.collect(); time.sleep(1.5); out.append(f"{rss_mb() - r0:.1f}")
    print(f"{name:16} x{n} per round, rss MB: {' / '.join(out)}", flush=True)

kind("client", 1000, lambda i: node.destroy_client(node.create_client(Trigger, f"c/c{i % 5}")))
kind("service", 1000, lambda i: node.destroy_service(node.create_service(Trigger, f"c/v{i % 5}", lambda req, res: res)))
def mk_node(i):
    n = rclpy.create_node(f"c_tmp_{i % 3}")
    n.destroy_node()
kind("node", 150, mk_node)
rclpy.shutdown()
