const http = require('http');
const { AgentVM } = require('./src/index.js');

const server = http.createServer((req, res) => {
    const size = parseInt(req.url.slice(1)) || 1024;
    res.writeHead(200, {'Content-Type': 'application/octet-stream', 'Content-Length': size});
    res.end(Buffer.alloc(size, 'x'));
});

server.listen(18896, '0.0.0.0', async () => {
    console.log('Server on :18896');
    
    const vm = new AgentVM();
    await vm.start();
    
    for (const sizeKB of [10, 50, 100, 200, 500]) {
        console.log(`Testing ${sizeKB}KB...`);
        const start = Date.now();
        try {
            const result = await vm.exec(`curl -s -o /tmp/test.bin http://192.168.127.1:18896/${sizeKB * 1024} && wc -c < /tmp/test.bin`, { timeout: 30000 });
            const elapsed = Date.now() - start;
            console.log(`  ${result.stdout.trim()} bytes in ${elapsed}ms (${((parseInt(result.stdout.trim()) / 1024) / (elapsed / 1000)).toFixed(1)} KB/s)`);
        } catch (e) {
            console.log(`  ERROR: ${e.message}`);
        }
    }
    
    await vm.stop();
    server.close();
    process.exit(0);
});
