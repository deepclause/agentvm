const { AgentVM } = require('./src/index');
const http = require('http');

async function main() {
    // Small test to narrow down the issue
    const sizes = [50 * 1024, 100 * 1024, 200 * 1024, 500 * 1024, 1024 * 1024];
    
    for (const size of sizes) {
        const server = http.createServer((req, res) => {
            console.log(`[Server] Sending ${size} bytes`);
            res.writeHead(200, { 'Content-Length': size });
            res.end(Buffer.alloc(size, 'x'));
        });
        
        await new Promise(r => server.listen(0, '127.0.0.1', r));
        const port = server.address().port;
        
        const vm = new AgentVM({ network: true });
        await vm.start();
        
        console.log(`\n=== Testing ${(size/1024).toFixed(0)}KB to /tmp/test ===`);
        const start = Date.now();
        try {
            const result = await Promise.race([
                vm.exec(`wget -q -O /tmp/test http://192.168.127.1:${port}/ && wc -c < /tmp/test`),
                new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 30000))
            ]);
            console.log(`Result: ${result.stdout.trim()} (${Date.now() - start}ms)`);
        } catch (e) {
            console.log(`Error: ${e.message} (${Date.now() - start}ms)`);
        }
        
        await vm.stop();
        server.close();
    }
}

main().catch(console.error);
