/**
 * Fast download debug test
 */

const { AgentVM } = require('./src/index');
const http = require('http');

function createFastServer(port) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const match = req.url.match(/\/bytes\/(\d+)/);
            if (match) {
                const size = parseInt(match[1]);
                console.log(`[Server] Sending ${size} bytes fast`);
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
    const server = await createFastServer(18080);
    
    // Enable debug mode
    const vm = new AgentVM({ network: true, debug: true });
    await vm.start();
    
    console.log('\n=== Testing 500KB fast download ===');
    let start = Date.now();
    try {
        const result = await Promise.race([
            vm.exec('wget -q -O /dev/null http://192.168.127.1:18080/bytes/512000 && echo OK'),
            new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 15000))
        ]);
        console.log(`Result: ${result.stdout.trim()} in ${Date.now() - start}ms`);
    } catch (e) {
        console.log(`FAILED: ${e.message} after ${Date.now() - start}ms`);
    }
    
    console.log('\n=== Testing 1MB fast download ===');
    start = Date.now();
    try {
        const result = await Promise.race([
            vm.exec('wget -q -O /dev/null http://192.168.127.1:18080/bytes/1048576 && echo OK'),
            new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 15000))
        ]);
        console.log(`Result: ${result.stdout.trim()} in ${Date.now() - start}ms`);
    } catch (e) {
        console.log(`FAILED: ${e.message} after ${Date.now() - start}ms`);
    }
    
    await vm.stop();
    server.close();
}

main().catch(console.error);
