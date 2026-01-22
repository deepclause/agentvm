/**
 * Simple comparison: /dev/null vs file
 */

const { AgentVM } = require('./src/index');
const http = require('http');

function createServer(port, size) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            console.log(`[Server] ${size} byte request`);
            res.writeHead(200, { 'Content-Length': size });
            res.end(Buffer.alloc(size, 'x'));
        });
        server.listen(port, '0.0.0.0', () => resolve(server));
    });
}

async function main() {
    const size = 1048576; // 1MB
    const server = await createServer(18080, size);
    console.log('[Test] Server ready\n');
    
    const vm = new AgentVM({ network: true, debug: false }); // No debug spam
    await vm.start();
    
    // Test 1: /dev/null
    console.log('=== Test 1: Download to /dev/null ===');
    let start = Date.now();
    try {
        const result = await Promise.race([
            vm.exec('wget -q -O /dev/null http://192.168.127.1:18080/'),
            new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 10000))
        ]);
        console.log(`SUCCESS in ${Date.now() - start}ms, exit=${result.exitCode}`);
    } catch (e) {
        console.log(`FAILED: ${e.message} after ${Date.now() - start}ms`);
    }
    
    // Test 2: File
    console.log('\n=== Test 2: Download to /tmp/dl ===');
    start = Date.now();
    try {
        const result = await Promise.race([
            vm.exec('wget -q -O /tmp/dl http://192.168.127.1:18080/ && echo OK'),
            new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 10000))
        ]);
        console.log(`SUCCESS in ${Date.now() - start}ms, exit=${result.exitCode}, out=${result.stdout.trim()}`);
    } catch (e) {
        console.log(`FAILED: ${e.message} after ${Date.now() - start}ms`);
    }
    
    await vm.stop();
    server.close();
}

main().catch(console.error);
