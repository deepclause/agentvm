/**
 * Deep VM Diagnostics - instrument the worker to see what's happening
 */

const { AgentVM } = require('./src/index');
const http = require('http');

function createTestServer(port) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const match = req.url.match(/\/bytes\/(\d+)/);
            if (match) {
                const size = parseInt(match[1]);
                console.log(`[Server] Sending ${size} bytes`);
                res.writeHead(200, { 'Content-Length': size });
                res.end(Buffer.alloc(size, 'x'));
            } else {
                res.writeHead(200);
                res.end('OK');
            }
        });
        server.listen(port, '0.0.0.0', () => resolve(server));
    });
}

async function main() {
    const server = await createTestServer(18080);
    console.log('[Test] Server ready\n');
    
    // Test 1: Pure network - no disk
    console.log('=== TEST 1: Download to /dev/null (no disk) ===');
    {
        const vm = new AgentVM({ network: true, debug: false });
        await vm.start();
        
        const start = Date.now();
        const result = await Promise.race([
            vm.exec('wget -q -O /dev/null http://192.168.127.1:18080/bytes/1048576 && echo OK'),
            new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 30000))
        ]);
        console.log(`Result: ${result.stdout.trim()} in ${Date.now() - start}ms`);
        await vm.stop();
    }
    
    // Test 2: Disk only - no network
    console.log('\n=== TEST 2: Local file write (no network) ===');
    {
        const vm = new AgentVM({ network: true, debug: false });
        await vm.start();
        
        const start = Date.now();
        const result = await Promise.race([
            vm.exec('dd if=/dev/zero of=/tmp/test bs=1M count=1 2>&1 && wc -c < /tmp/test'),
            new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 30000))
        ]);
        console.log(`Result: ${result.stdout.trim().split('\n').pop()} bytes in ${Date.now() - start}ms`);
        await vm.stop();
    }
    
    // Test 3: Network + disk (small)
    console.log('\n=== TEST 3: Download 100KB to file ===');
    {
        const vm = new AgentVM({ network: true, debug: false });
        await vm.start();
        
        const start = Date.now();
        const result = await Promise.race([
            vm.exec('wget -q -O /tmp/dl http://192.168.127.1:18080/bytes/102400 && wc -c < /tmp/dl'),
            new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 30000))
        ]);
        console.log(`Result: ${result.stdout.trim()} bytes in ${Date.now() - start}ms`);
        await vm.stop();
    }
    
    // Test 4: Network + disk (medium)
    console.log('\n=== TEST 4: Download 500KB to file ===');
    {
        const vm = new AgentVM({ network: true, debug: false });
        await vm.start();
        
        const start = Date.now();
        const result = await Promise.race([
            vm.exec('wget -q -O /tmp/dl http://192.168.127.1:18080/bytes/512000 && wc -c < /tmp/dl'),
            new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 30000))
        ]);
        console.log(`Result: ${result.stdout.trim()} bytes in ${Date.now() - start}ms`);
        await vm.stop();
    }
    
    // Test 5: Network + disk (1MB) - this should fail
    console.log('\n=== TEST 5: Download 1MB to file ===');
    {
        const vm = new AgentVM({ network: true, debug: false });
        await vm.start();
        
        const start = Date.now();
        try {
            const result = await Promise.race([
                vm.exec('wget -q -O /tmp/dl http://192.168.127.1:18080/bytes/1048576 && wc -c < /tmp/dl'),
                new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 30000))
            ]);
            console.log(`Result: ${result.stdout.trim()} bytes in ${Date.now() - start}ms`);
        } catch (e) {
            console.log(`FAILED: ${e.message} after ${Date.now() - start}ms`);
        }
        await vm.stop();
    }
    
    // Test 6: Incremental to find boundary
    console.log('\n=== TEST 6: Find exact boundary ===');
    const sizes = [600000, 700000, 800000, 900000, 1000000];
    for (const size of sizes) {
        const vm = new AgentVM({ network: true, debug: false });
        await vm.start();
        
        process.stdout.write(`${(size/1024).toFixed(0)}KB: `);
        const start = Date.now();
        try {
            const result = await Promise.race([
                vm.exec(`wget -q -O /tmp/dl http://192.168.127.1:18080/bytes/${size} && wc -c < /tmp/dl`),
                new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 20000))
            ]);
            const got = parseInt(result.stdout.trim());
            console.log(`${got === size ? 'OK' : 'WRONG SIZE'} (${Date.now() - start}ms)`);
        } catch (e) {
            console.log(`TIMEOUT (${Date.now() - start}ms)`);
            await vm.stop();
            break;
        }
        await vm.stop();
    }
    
    server.close();
    console.log('\nDone!');
}

main().catch(console.error);
