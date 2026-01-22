const { AgentVM } = require('./src/index');
const { NetworkStack } = require('./src/network');

// Monkey-patch to expose stats
let netStackInstance = null;
const origConstructor = NetworkStack.prototype.constructor;

(async () => {
    const vm = new AgentVM({ network: true, debug: true });
    await vm.start();
    
    // Access the network stack via the worker's message
    console.log('Testing 10MB download with detailed logging...\n');
    
    // Start periodic stats logging
    let lastDataFromMain = 0;
    let stallCount = 0;
    const statsInterval = setInterval(() => {
        // We can't directly access worker's netStack, but debug messages will show progress
    }, 1000);
    
    const start = Date.now();
    const res = await Promise.race([
        vm.exec('wget -q -O /tmp/test.bin http://speedtest.tele2.net/1MB.zip && wc -c /tmp/test.bin'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 60000))
    ]).catch(e => ({ stdout: e.message, stderr: '', exitCode: -1 }));
    
    clearInterval(statsInterval);
    
    const elapsed = Date.now() - start;
    console.log(`\nResult (${elapsed}ms): ${res.stdout.trim()}`);
    console.log(`Exit code: ${res.exitCode}`);
    
    console.log('Stopping VM...');
    await Promise.race([
        vm.stop(),
        new Promise((_, reject) => setTimeout(() => {
            console.log('vm.stop() timed out, force exiting');
            process.exit(res.exitCode === 0 ? 0 : 1);
        }, 5000))
    ]);
    console.log('VM stopped');
    
    process.exit(res.exitCode === 0 ? 0 : 1);
})();
