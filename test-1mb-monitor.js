const { AgentVM } = require('./src/index');
const http = require('http');

async function main() {
    const server = http.createServer((req, res) => {
        const size = 1024 * 1024; // 1MB
        console.log('[Server] Sending', size, 'bytes');
        res.writeHead(200, { 'Content-Length': size });
        // Send in chunks to observe flow
        let sent = 0;
        const chunkSize = 64 * 1024;
        const interval = setInterval(() => {
            const remaining = size - sent;
            if (remaining <= 0) {
                clearInterval(interval);
                res.end();
                console.log('[Server] Done sending all data');
                return;
            }
            const toSend = Math.min(chunkSize, remaining);
            const ok = res.write(Buffer.alloc(toSend, 'x'));
            sent += toSend;
            console.log(`[Server] Sent ${sent}/${size} bytes, backpressure=${!ok}`);
        }, 10);
    });
    
    await new Promise(r => server.listen(18080, '0.0.0.0', r));
    console.log('Server ready on port 18080');
    
    const vm = new AgentVM({ network: true });
    await vm.start();
    
    // Monitor progress
    let lastOutput = Date.now();
    const monitor = setInterval(() => {
        const now = Date.now();
        console.log(`[Monitor] ${(now - lastOutput) / 1000}s since last output`);
    }, 5000);
    
    console.log('\n=== Download 1MB to file ===');
    const start = Date.now();
    try {
        const result = await Promise.race([
            vm.exec('wget -q -O /tmp/large http://192.168.127.1:18080/ && wc -c < /tmp/large'),
            new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 60000))
        ]);
        console.log('Result:', result.stdout.trim(), `(${Date.now() - start}ms)`);
    } catch (e) {
        console.log('Error:', e.message, `(${Date.now() - start}ms)`);
    }
    
    clearInterval(monitor);
    await vm.stop();
    server.close();
}

main().catch(console.error);
