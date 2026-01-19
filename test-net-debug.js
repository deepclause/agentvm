const { AgentVM } = require('./src/index');

async function test() {
  console.log('Starting VM without network args...');
  const vm = new AgentVM();
  
  await vm.start();
  console.log('VM started!\n');
  
  // Just a simple command to see what happens
  let r = await vm.exec('echo hello');
  console.log('\nResult:', r.stdout);
  
  // Check eth0
  r = await vm.exec('ip link show eth0');
  console.log('\neth0:', r.stdout);
  
  r = await vm.exec('dmesg | grep -i net | head -5');
  console.log('\ndmesg net:', r.stdout);
  
  await vm.stop();
  console.log('Done!');
}

test().catch(e => { console.error(e); process.exit(1); });
