/**
 * Throttled Server Test - send data slowly to match VM processing speed
 */

const { AgentVM } = require('./src/index');
const http = require('http');

function createThrottledServer(port, bytesPerSec = 500000) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const match = req.url.match(/\/bytes\/(\d+)/);
            if (match) {
                const totalSize = parseInt(match[1]);
                console.log(`[Server] Starting ${totalSize} bytes at ${bytesPerSec/1024}KB/s`);
                res.writeHead(200, { 'Content-Length': totalSize });
                
                let sent = 0;
                const chunkSize = Math.min(16384, totalSize); // 16KB chunks
                const delayMs = (chunkSize / bytesPerSec) * 1000;
                
                function sendChunk() {
                    if (sent >= totalSize) {
                        res.end();
                        console.log(`[Server] Done sending ${totalSize} bytes`);
                        return;
                    }
                    
                    const remaining = totalSize - sent;
                    const toSend = Math.min(chunkSize, remaining);
                    res.write(Buffer.alloc(toSend, 'x'));
                    sent += toSend;
                    
                    setTimeout(sendChunk, delayMs);
                }
                
                sendChunk();
            } else {
                res.writeHead(200);
                res.end('OK');
            }
        });
        server.listen(port, '0.0.0.0', () => resolve(server));
    });
}

async function main() {
    // Throttle to ~500KB/s
    const server = await createThrottledServer(18080, 500000);
    console.log('[Test] Throttled server ready (500KB/s)\n');
    
    const vm = new AgentVM({ network: true, debug: false });
    await vm.start();
    
    // Test with throttled 500KB
    console.log('=== TEST: Download 500KB to /dev/null (throttled) ===');
    let start = Date.now();
    try {
        const result = await Promise.race([
            vm.exec('wget -q -O /dev/null http://192.168.127.1:18080/bytes/512000 && echo OK'),
            new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 30000))
        ]);
        console.log(`Result: ${result.stdout.trim()} in ${Date.now() - start}ms\n`);
    } catch (e) {
        console.log(`FAILED: ${e.message} after ${Date.now() - start}ms\n`);
    }
    
    // Test with throttled 1MB
    console.log('=== TEST: Download 1MB to /dev/null (throttled) ===');
    start = Date.now();
    try {
        const result = await Promise.race([
            vm.exec('wget -q -O /dev/null http://192.168.127.1:18080/bytes/1048576 && echo OK'),
            new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 60000))
        ]);
        console.log(`Result: ${result.stdout.trim()} in ${Date.now() - start}ms\n`);
    } catch (e) {
        console.log(`FAILED: ${e.message} after ${Date.now() - start}ms\n`);
    }
    
    await vm.stop();
    server.close();
}

main().catch(console.error);
