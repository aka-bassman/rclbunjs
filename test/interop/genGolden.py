"""Generates CDR golden vectors with rclpy for the codec unit tests.

Run inside the dev container:  python3 test/interop/genGolden.py test/fixtures
Writes golden.json and copies the needed interface definitions so the unit
tests can run on a host without ROS (AMENT_PREFIX_PATH=test/fixtures/ament).
"""
import array
import json
import math
import os
import shutil
import sys

from rclpy.serialization import serialize_message
from rosidl_runtime_py.convert import message_to_ordereddict
import test_msgs.message_fixtures as fx
from std_msgs.msg import String, Header, ColorRGBA
from geometry_msgs.msg import Twist, PoseStamped, Vector3
from sensor_msgs.msg import Image, JointState, PointCloud2, PointField

out_dir = sys.argv[1]


def plain(v):
    if type(v).__module__ == 'numpy' and hasattr(v, 'item') and type(v).__name__ != 'ndarray':
        v = v.item()
    if isinstance(v, dict):
        return {k: plain(x) for k, x in v.items()}
    if isinstance(v, (list, tuple, array.array)) or type(v).__name__ == 'ndarray':
        return [plain(x) for x in list(v)]
    if isinstance(v, bytes):
        return [b for b in v]
    if isinstance(v, bool):
        return v
    if isinstance(v, int):
        return {'$int': str(v)} if abs(v) > 2**53 else v
    if isinstance(v, float):
        if math.isnan(v):
            return {'$float': 'nan'}
        if math.isinf(v):
            return {'$float': 'inf' if v > 0 else '-inf'}
        return v
    return v


cases = []


def to_plain(msg):
    out = {}
    for name, t in msg.get_fields_and_field_types().items():
        out[name] = conv(getattr(msg, name), t)
    return out


def conv(v, t):
    base = t.split('[')[0].replace('sequence<', '').split(',')[0].rstrip('>')
    if hasattr(v, 'get_fields_and_field_types'):
        return to_plain(v)
    if base in ('byte', 'char', 'octet'):
        if isinstance(v, (bytes, bytearray)):
            return list(v) if ('[' in t or 'sequence' in t) else v[0]
        if isinstance(v, str):
            return ord(v) if v else 0
        if isinstance(v, int) or type(v).__module__ == 'numpy' and type(v).__name__ != 'ndarray':
            return int(v)
        return [conv(x, base) for x in v]
    if isinstance(v, (list, tuple, array.array)) or type(v).__name__ == 'ndarray':
        return [conv(x, base) for x in list(v)]
    return plain(v)


def add(type_name, msg):
    cases.append({'type': type_name, 'hex': serialize_message(msg).hex(), 'value': to_plain(msg)})


names = ['Arrays', 'BasicTypes', 'BoundedPlainSequences', 'BoundedSequences', 'Builtins', 'Constants',
         'Defaults', 'Empty', 'MultiNested', 'Nested', 'Strings', 'UnboundedSequences', 'WStrings']
for n in names:
    for m in fx.get_test_msg(n):
        add(f'test_msgs/msg/{n}', m)

add('std_msgs/msg/String', String(data='hello ✓ 한글'))
add('std_msgs/msg/Header', Header(frame_id='map'))
add('std_msgs/msg/ColorRGBA', ColorRGBA(r=0.1, g=0.2, b=0.3, a=1.0))
t = Twist(); t.linear.x = 1.5; t.angular.z = -0.25
add('geometry_msgs/msg/Twist', t)
p = PoseStamped(); p.header.frame_id = 'base'; p.header.stamp.sec = 12; p.header.stamp.nanosec = 34; p.pose.orientation.w = 1.0
add('geometry_msgs/msg/PoseStamped', p)
img = Image(height=2, width=3, encoding='rgb8', step=9, data=bytes(range(18)))
add('sensor_msgs/msg/Image', img)
add('sensor_msgs/msg/JointState', JointState(name=['a', 'b'], position=[1.0, 2.0], velocity=[], effort=[0.5]))
pc = PointCloud2(height=1, width=1, fields=[PointField(name='x', offset=0, datatype=7, count=1)], point_step=4, row_step=4, data=bytes(4), is_dense=True)
add('sensor_msgs/msg/PointCloud2', pc)

with open(os.path.join(out_dir, 'golden.json'), 'w') as f:
    json.dump(cases, f, indent=0)

# Copy definitions for host-side tests.
src = '/opt/ros/' + os.environ['ROS_DISTRO']
dst = os.path.join(out_dir, 'ament')
for pkg in ['test_msgs', 'builtin_interfaces', 'std_msgs', 'geometry_msgs', 'sensor_msgs',
            'unique_identifier_msgs', 'action_msgs', 'example_interfaces', 'rcl_interfaces', 'std_srvs']:
    for kind in ['msg', 'srv', 'action']:
        s = os.path.join(src, 'share', pkg, kind)
        if os.path.isdir(s):
            d = os.path.join(dst, 'share', pkg, kind)
            os.makedirs(d, exist_ok=True)
            for f in os.listdir(s):
                if f.endswith(('.msg', '.srv', '.action', '.idl')):
                    shutil.copy(os.path.join(s, f), d)
    idx = os.path.join(src, 'share', 'ament_index', 'resource_index', 'rosidl_interfaces', pkg)
    if os.path.exists(idx):
        d = os.path.join(dst, 'share', 'ament_index', 'resource_index', 'rosidl_interfaces')
        os.makedirs(d, exist_ok=True)
        shutil.copy(idx, d)
print(f'{len(cases)} cases')
