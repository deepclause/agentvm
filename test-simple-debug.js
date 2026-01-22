const { AgentVM } = require('./src/index');
const http = require('http');

async function test(outputPath) {
    const size = 100 * 1024; // 100KB
    const server = http.createServer((req, res) => {
        console.log(`[Server] Sending ${size} bytes`);
        res.writeHead(200, { 'Content-Length': size });
        res.end(Buffer.alloc(size, 'x'));
    });
    
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    
    const vm = new AgentVM({ network: true });
    await vm.start();
    
    console.log(`\n=== Testing 100KB to ${outputPath} ===`);
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
    await test('/dev/null');  // Should work
    await test('/tmp/test');  // Should fail currently
}

main().catch(console.error);
