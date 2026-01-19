const { AgentVM } = require('./src/index');

async function test() {
  const vm = new AgentVM();
  await vm.start();
  
  // Check virtio features
  let r = await vm.exec('cat /sys/class/net/eth0/device/features 2>&1');
  console.log('virtio features:', r.stdout);
  
  // Check virtio status
  r = await vm.exec('cat /sys/class/net/eth0/device/status 2>&1');
  console.log('virtio status:', r.stdout);
  
  // Try using netlink directly with raw sockets (we have CAP_NET_RAW)
  const pythonCode = `
import socket
try:
    s = socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, 0)
    print(f"Netlink socket: fd={s.fileno()}")
except Exception as e:
    print(f"Netlink error: {e}")
`;
  r = await vm.exec(`python3 -c '${pythonCode}' 2>&1`);
  console.log('netlink test:', r.stdout);
  
  // Try to configure interface via netlink (requires CAP_NET_ADMIN though)
  const linkUpCode = `
import socket
import struct

# RTM_SETLINK = 19
# AF_UNSPEC = 0
# IFLA_IFNAME = 3
# IFF_UP = 1

NETLINK_ROUTE = 0

try:
    s = socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, NETLINK_ROUTE)
    s.bind((0, 0))
    print(f"Netlink bound, pid={s.getsockname()}")
    
    # This would need CAP_NET_ADMIN
    # Just see if we can receive messages
except Exception as e:
    print(f"Error: {e}")
`;
  r = await vm.exec(`python3 -c '${linkUpCode}' 2>&1`);
  console.log('netlink route test:', r.stdout);
  
  await vm.stop();
}

test().catch(e => console.error(e));
