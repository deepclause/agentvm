const { AgentVM } = require('./src/index');
const http = require('http');

async function main() {
    const server = http.createServer((req, res) => {
        const size = 1024 * 1024; // 1MB - larger test
        console.log('[Server] Sending', size, 'bytes');
        res.writeHead(200, { 'Content-Length': size });
        res.end(Buffer.alloc(size, 'x'), () => console.log('[Server] Done'));
    });
    
    await new Promise(r => server.listen(18080, '0.0.0.0', r));
    console.log('Server ready');
    
    const vm = new AgentVM({ network: true });
    await vm.start();
    
    console.log('\nStarting 1MB download to /dev/null...');
    const start = Date.now();
    try {
        const result = await Promise.race([
            vm.exec('wget -q -O /dev/null http://192.168.127.1:18080/ && echo OK'),
            new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 60000))
        ]);
        console.log('Result:', result.stdout.trim(), `(${Date.now() - start}ms)`);
    } catch (e) {
        console.log('Error:', e.message, `(${Date.now() - start}ms)`);
    }
    
    console.log('\nStarting 1MB download to file...');
    const start2 = Date.now();
    try {
        const result = await Promise.race([
            vm.exec('wget -q -O /tmp/test http://192.168.127.1:18080/ && wc -c < /tmp/test'),
            new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 120000))
        ]);
        console.log('Result:', result.stdout.trim(), `(${Date.now() - start2}ms)`);
    } catch (e) {
        console.log('Error:', e.message, `(${Date.now() - start2}ms)`);
    }
    
    await vm.stop();
    server.close();
}

main().catch(console.error);
