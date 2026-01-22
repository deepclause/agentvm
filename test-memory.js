const { AgentVM } = require('./src/index');

(async () => {
    const vm = new AgentVM({ network: true, debug: true });
    await vm.start();
    
    console.log('Checking VM memory...\n');
    
    // Check /proc/meminfo inside VM
    const meminfo = await vm.exec('cat /proc/meminfo');
    console.log('=== /proc/meminfo ===');
    console.log(meminfo.stdout);
    
    // Check free memory
    const free = await vm.exec('free -m 2>/dev/null || cat /proc/meminfo | head -5');
    console.log('=== free ===');
    console.log(free.stdout);
    
    // Check ulimits
    const ulimit = await vm.exec('ulimit -a 2>/dev/null || echo "ulimit not available"');
    console.log('=== ulimit ===');
    console.log(ulimit.stdout);
    
    // Try to allocate memory with dd
    console.log('=== Testing memory allocation ===');
    const ddTest = await vm.exec('dd if=/dev/zero of=/tmp/memtest bs=1M count=20 2>&1 && ls -la /tmp/memtest && rm /tmp/memtest');
    console.log(ddTest.stdout);
    console.log(ddTest.stderr);
    
    await vm.stop();
})();
