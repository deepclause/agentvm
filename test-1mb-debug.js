const { AgentVM } = require('./src/index');
const http = require('http');

async function main() {
    // Set debug environment
    process.env.DEBUG_WASI_PATH = '0'; // Set to '1' for path debugging

    const server = http.createServer((req, res) => {
        const size = 1024 * 1024; // 1MB
        console.log('[Server] Sending', size, 'bytes');
        res.writeHead(200, { 'Content-Length': size });
        res.end(Buffer.alloc(size, 'x'), () => console.log('[Server] Response sent completely'));
    });
    
    await new Promise(r => server.listen(18080, '0.0.0.0', r));
    console.log('Server ready on port 18080');
    
    const vm = new AgentVM({ network: true });
    await vm.start();
    
    // Test 1: /dev/null (should work)
    console.log('\n=== TEST 1: Download to /dev/null ===');
    const start1 = Date.now();
    try {
        const result = await Promise.race([
            vm.exec('wget -q -O /dev/null http://192.168.127.1:18080/ && echo OK'),
            new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 60000))
        ]);
        console.log('Result:', result.stdout.trim(), `(${Date.now() - start1}ms)`);
    } catch (e) {
        console.log('Error:', e.message, `(${Date.now() - start1}ms)`);
    }
    
    // Test 2: Small file first
    console.log('\n=== TEST 2: Download 10KB to file ===');
    const server2 = http.createServer((req, res) => {
        const size = 10 * 1024; // 10KB
        console.log('[Server2] Sending', size, 'bytes');
        res.writeHead(200, { 'Content-Length': size });
        res.end(Buffer.alloc(size, 'y'), () => console.log('[Server2] Done'));
    });
    await new Promise(r => server2.listen(18081, '0.0.0.0', r));
    
    const start2 = Date.now();
    try {
        const result = await Promise.race([
            vm.exec('wget -q -O /tmp/small http://192.168.127.1:18081/ && wc -c < /tmp/small'),
            new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 30000))
        ]);
        console.log('Result:', result.stdout.trim(), `(${Date.now() - start2}ms)`);
    } catch (e) {
        console.log('Error:', e.message, `(${Date.now() - start2}ms)`);
    }
    server2.close();
    
    // Test 3: 100KB file
    console.log('\n=== TEST 3: Download 100KB to file ===');
    const server3 = http.createServer((req, res) => {
        const size = 100 * 1024; // 100KB
        console.log('[Server3] Sending', size, 'bytes');
        res.writeHead(200, { 'Content-Length': size });
        res.end(Buffer.alloc(size, 'z'), () => console.log('[Server3] Done'));
    });
    await new Promise(r => server3.listen(18082, '0.0.0.0', r));
    
    const start3 = Date.now();
    try {
        const result = await Promise.race([
            vm.exec('wget -q -O /tmp/medium http://192.168.127.1:18082/ && wc -c < /tmp/medium'),
            new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 30000))
        ]);
        console.log('Result:', result.stdout.trim(), `(${Date.now() - start3}ms)`);
    } catch (e) {
        console.log('Error:', e.message, `(${Date.now() - start3}ms)`);
    }
    server3.close();
    
    // Test 4: 1MB to file
    console.log('\n=== TEST 4: Download 1MB to file ===');
    const start4 = Date.now();
    try {
        const result = await Promise.race([
            vm.exec('wget -q -O /tmp/large http://192.168.127.1:18080/ && wc -c < /tmp/large'),
            new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 120000))
        ]);
        console.log('Result:', result.stdout.trim(), `(${Date.now() - start4}ms)`);
    } catch (e) {
        console.log('Error:', e.message, `(${Date.now() - start4}ms)`);
    }
    
    await vm.stop();
    server.close();
}

main().catch(console.error);
