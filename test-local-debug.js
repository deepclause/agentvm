const { AgentVM } = require('./src/index');
const http = require('http');

async function main() {
    const server = http.createServer((req, res) => {
        console.log('[Server] Request:', req.url);
        const match = req.url.match(/\/bytes\/(\d+)/);
        if (match) {
            const size = parseInt(match[1]);
            console.log('[Server] Sending', size, 'bytes');
            res.writeHead(200, { 'Content-Length': size });
            res.end(Buffer.alloc(size, 'x'), () => {
                console.log('[Server] Sent complete');
            });
        }
    });
    await new Promise(r => server.listen(18080, '0.0.0.0', r));
    console.log('Server ready on port 18080');
    
    const vm = new AgentVM({ network: true });
    await vm.start();
    
    // First test connectivity
    console.log('\nTest 1: Simple ping to gateway');
    let result = await vm.exec('ping -c 1 192.168.127.1 2>&1 | head -2');
    console.log(result.stdout);
    
    console.log('\nTest 2: Small wget to /dev/null (1KB)');
    result = await Promise.race([
        vm.exec('wget -q -O /dev/null http://192.168.127.1:18080/bytes/1024 && echo OK'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 10000))
    ]);
    console.log('Result:', result.stdout.trim());
    
    console.log('\nTest 3: 10KB wget to /dev/null');
    result = await Promise.race([
        vm.exec('wget -q -O /dev/null http://192.168.127.1:18080/bytes/10240 && echo OK'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 10000))
    ]);
    console.log('Result:', result.stdout.trim());
    
    console.log('\nTest 4: 10KB wget to file');
    result = await Promise.race([
        vm.exec('wget -q -O /tmp/test http://192.168.127.1:18080/bytes/10240 && wc -c < /tmp/test'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 10000))
    ]);
    console.log('Result:', result.stdout.trim());
    
    // Test various sizes
    const sizes = [500, 1000, 2000, 3000, 5000, 10000]; // KB
    for (const sizeKB of sizes) {
        const size = sizeKB * 1024;
        console.log(`\nTest: ${sizeKB}KB wget to file`);
        const start = Date.now();
        try {
            result = await Promise.race([
                vm.exec(`wget -q -O /tmp/test http://192.168.127.1:18080/bytes/${size} && wc -c < /tmp/test`),
                new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 120000))
            ]);
            const elapsed = Date.now() - start;
            const got = parseInt(result.stdout.trim());
            const speed = (size / 1024 / 1024) / (elapsed / 1000);
            console.log(`Result: ${got === size ? 'OK' : 'WRONG(' + got + ')'} (${elapsed}ms, ${speed.toFixed(2)} MB/s)`);
        } catch (e) {
            console.log(`Result: ${e.message} (${Date.now() - start}ms)`);
            break;
        }
    }

    await vm.stop();
    server.close();
    console.log('\nDone!');
}

main().catch(console.error);
