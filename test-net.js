const { AgentVM } = require('./src/index');

async function test() {
  console.log('Starting VM with network...');
  const vm = new AgentVM({ network: true, mac: '02:00:00:00:00:01' });
  await vm.start();
  console.log('VM started!');
  
  // Check interface status
  let r = await vm.exec('ip link show eth0');
  console.log('=== eth0 link ===\n' + r.stdout);
  
  r = await vm.exec('cat /sys/class/net/eth0/operstate 2>&1');
  console.log('operstate:', r.stdout.trim());
  
  // Try bringing up interface
  r = await vm.exec('ip link set eth0 up 2>&1; echo "exit:$?"');
  console.log('ip link up result:', r.stdout.trim());
  
  r = await vm.exec('ip link show eth0');
  console.log('=== eth0 after up ===\n' + r.stdout);
  
  // Try DHCP
  r = await vm.exec('udhcpc -i eth0 -n -q -T 3 -t 2 2>&1; echo "dhcp exit:$?"');
  console.log('udhcpc:', r.stdout);
  
  // Check IP
  r = await vm.exec('ip addr show eth0');
  console.log('=== eth0 addr ===\n' + r.stdout);
  
  await vm.stop();
  console.log('Done!');
}

test().catch(e => { console.error(e); process.exit(1); });
