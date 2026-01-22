/**
 * Local Server Connection Test
 */

const { AgentVM } = require('./src/index');
const http = require('http');

function createTestServer(port) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            console.log(`[Server] Request: ${req.method} ${req.url}`);
            const match = req.url.match(/\/bytes\/(\d+)/);
            if (match) {
                const size = parseInt(match[1]);
                console.log(`[Server] Sending ${size} bytes`);
                res.writeHead(200, { 'Content-Length': size });
                res.end(Buffer.alloc(size, 'x'));
            } else {
                res.writeHead(200);
                res.end('Hello from local server!');
            }
        });
        server.listen(port, '0.0.0.0', () => {
            console.log(`[Server] Listening on 0.0.0.0:${port}`);
            resolve(server);
        });
    });
}

async function main() {
    const server = await createTestServer(18080);
    
    const vm = new AgentVM({ network: true, debug: true });
    await vm.start();
    
    const hostIP = '192.168.127.1';
    
    console.log('\n[Test] Checking VM network...');
    let result = await vm.exec('ip addr show eth0 | grep inet');
    console.log('[VM] IP:', result.stdout.trim());
    
    console.log('\n[Test] Pinging gateway...');
    result = await vm.exec('ping -c 1 192.168.127.1');
    console.log('[VM] Ping result:', result.exitCode === 0 ? 'OK' : 'FAILED');
    
    console.log('\n[Test] Testing small HTTP request to local server...');
    const start = Date.now();
    try {
        result = await Promise.race([
            vm.exec(`wget -q -O - http://${hostIP}:18080/`),
            new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 10000))
        ]);
        console.log('[VM] Response:', result.stdout.trim());
    } catch (e) {
        console.log('[VM] Error:', e.message);
    }
    console.log(`[Test] Took ${Date.now() - start}ms`);
    
    await vm.stop();
    server.close();
}

main().catch(console.error);
