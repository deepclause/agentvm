const { AgentVM } = require('./src/index');
const http = require('http');

async function test(outputPath, throttleMs) {
    const size = 100 * 1024; // 100KB
    const chunkSize = 1024; // 1KB chunks
    
    const server = http.createServer((req, res) => {
        console.log(`[Server] Sending ${size} bytes in ${chunkSize}B chunks with ${throttleMs}ms delay`);
        res.writeHead(200, { 'Content-Length': size });
        
        let sent = 0;
        const sendChunk = () => {
            if (sent >= size) {
                res.end();
                return;
            }
            const chunk = Buffer.alloc(Math.min(chunkSize, size - sent), 'x');
            res.write(chunk);
            sent += chunk.length;
            if (throttleMs > 0) {
                setTimeout(sendChunk, throttleMs);
            } else {
                setImmediate(sendChunk);
            }
        };
        sendChunk();
    });
    
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    
    const vm = new AgentVM({ network: true });
    await vm.start();
    
    console.log(`\n=== Testing 100KB to ${outputPath} (throttle=${throttleMs}ms) ===`);
    const start = Date.now();
    try {
        const result = await Promise.race([
            vm.exec(`wget -q -O ${outputPath} http://192.168.127.1:${port}/ && echo DONE`),
            new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 30000))
        ]);
        console.log(`Result: ${result.stdout.trim()} (${Date.now() - start}ms)`);
    } catch (e) {
        console.log(`Error: ${e.message} (${Date.now() - start}ms)`);
    }
    
    await vm.stop();
    server.close();
}

async function main() {
    // Test with different throttle speeds
    console.log("Testing /tmp/test with throttled speeds...");
    await test('/tmp/test', 10);  // 10ms between 1KB chunks
}

main().catch(console.error);
