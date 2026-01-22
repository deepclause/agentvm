/**
 * Debug file download issue
 * Add instrumentation to track where things get stuck
 */

const { AgentVM } = require('./src/index');
const http = require('http');

function createServer(port) {
    return new Promise((resolve) => {
        let bytesSent = 0;
        const server = http.createServer((req, res) => {
            const size = 1048576; // 1MB
            console.log(`[Server] Starting ${size} byte transfer`);
            res.writeHead(200, { 'Content-Length': size });
            
            // Send in chunks with small delays to give event loop breathing room
            const chunkSize = 16384; // 16KB chunks
            let sent = 0;
            
            function sendChunk() {
                if (sent >= size) {
                    res.end();
                    console.log(`[Server] Transfer complete: ${sent} bytes`);
                    return;
                }
                
                const toSend = Math.min(chunkSize, size - sent);
                const canWrite = res.write(Buffer.alloc(toSend, 'x'));
                sent += toSend;
                bytesSent = sent;
                
                if (canWrite) {
                    // Immediate next chunk, but yield to event loop
                    setImmediate(sendChunk);
                } else {
                    // Backpressure - wait for drain
                    res.once('drain', sendChunk);
                }
            }
            
            sendChunk();
        });
        
        // Monitor progress
        const monitor = setInterval(() => {
            console.log(`[Monitor] Server sent: ${(bytesSent/1024).toFixed(0)}KB`);
        }, 500);
        
        server.on('close', () => clearInterval(monitor));
        
        server.listen(port, '0.0.0.0', () => resolve({ server, getBytesSent: () => bytesSent }));
    });
}

async function main() {
    const { server, getBytesSent } = await createServer(18080);
    console.log('[Test] Server ready\n');
    
    const vm = new AgentVM({ network: true, debug: true });
    await vm.start();
    
    console.log('=== Test: 1MB download to /tmp/dl ===');
    const start = Date.now();
    
    try {
        const result = await Promise.race([
            vm.exec('wget -q -O /tmp/dl http://192.168.127.1:18080/ && wc -c < /tmp/dl'),
            new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 30000))
        ]);
        console.log(`\nResult: ${result.stdout.trim()} bytes in ${Date.now() - start}ms`);
    } catch (e) {
        console.log(`\nFailed: ${e.message} after ${Date.now() - start}ms`);
        console.log(`Server had sent: ${getBytesSent()} bytes`);
    }
    
    await vm.stop();
    server.close();
}

main().catch(console.error);
