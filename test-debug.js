const http = require('http');
const { AgentVM } = require('./src/index.js');

const server = http.createServer((req, res) => {
    const size = parseInt(req.url.slice(1)) || 1024;
    console.log(`HTTP: Received request for ${size} bytes`);
    res.writeHead(200, {'Content-Type': 'application/octet-stream', 'Content-Length': size});
    res.end(Buffer.alloc(size, 'x'));
    console.log(`HTTP: Sent ${size} bytes`);
});

server.listen(18897, '0.0.0.0', async () => {
    console.log('Server on :18897');
    
    const vm = new AgentVM({ debug: true });
    await vm.start();
    
    console.log('Testing 100KB...');
    const start = Date.now();
    try {
        const result = await vm.exec(`curl -s -o /tmp/test.bin http://192.168.127.1:18897/102400 && wc -c < /tmp/test.bin`, { timeout: 30000 });
        const elapsed = Date.now() - start;
        console.log(`Result: ${result.stdout.trim()} bytes in ${elapsed}ms`);
    } catch (e) {
        console.log(`ERROR: ${e.message}`);
    }
    
    await vm.stop();
    server.close();
    process.exit(0);
});
