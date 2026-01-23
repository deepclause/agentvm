const http = require('http');
const { AgentVM } = require('./src/index.js');

// Create test server
const server = http.createServer((req, res) => {
    console.log('[SERVER] Request received for', req.url);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
});

async function run() {
    await new Promise(r => server.listen(39100, '127.0.0.1', r));
    console.log('[SERVER] Listening on 39100');
    
    const vm = new AgentVM({
        wasmPath: '/home/andreas/git/gh/agentvm/agentvm-alpine-python.wasm.v1',
        env: {},
        mountDir: '/tmp',
        debug: true
    });
    
    // Wait for VM to be ready
    await new Promise(r => vm.once('ready', r));
    console.log('[VM] Ready');
    
    console.log('\n=== Starting Request 1 ===');
    const r1 = await vm.exec('curl -s -m 5 http://192.168.1.1:39100/test1');
    console.log('Request 1 result:', r1.stdout.toString().trim() || '(empty)', '| exit:', r1.exitCode);
    
    // Add a delay between requests
    console.log('\nWaiting 1 second...');
    await new Promise(r => setTimeout(r, 1000));
    
    console.log('\n=== Starting Request 2 ===');
    const r2 = await vm.exec('curl -s -m 5 http://192.168.1.1:39100/test2');
    console.log('Request 2 result:', r2.stdout.toString().trim() || '(empty)', '| exit:', r2.exitCode);
    
    vm.kill();
    server.close();
}

run().catch(e => { console.error(e); process.exit(1); });
