const http = require('http');
const crypto = require('crypto');
const { AgentVM } = require('./src/index');

async function test() {
    const size = 1024; // 1KB - small file
    const data = crypto.randomBytes(size);
    const server = http.createServer((req, res) => {
        console.log('Got request');
        res.writeHead(200, { 'Content-Length': size });
        res.end(data);
        console.log('Sent response');
    });
    await new Promise(r => server.listen(18888, '127.0.0.1', r));
    console.log('Server started');
    
    const vm = new AgentVM({ network: true, debug: true });
    await vm.start();
    
    console.log('Testing wget (exec mode)...');
    const startWget = Date.now();
    try {
        const resultWget = await vm.exec('wget -q http://192.168.127.1:18888/ -O /tmp/test.bin && ls -la /tmp/test.bin');
        console.log('wget Time:', Date.now() - startWget, 'ms');
        console.log(resultWget.stdout);
    } catch (e) {
        console.log('wget error:', e.message);
    }
    
    await vm.stop();
    server.close();
}
test().catch(console.error);
