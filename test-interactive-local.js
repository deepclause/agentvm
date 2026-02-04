const http = require('http');
const crypto = require('crypto');
const { AgentVM } = require('./src/index');

async function test() {
    const size = 100 * 1024; // 100KB
    const data = crypto.randomBytes(size);
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Length': size });
        res.end(data);
    });
    await new Promise(r => server.listen(18888, '127.0.0.1', r));
    console.log('Server started');
    
    const vm = new AgentVM({ network: true, debug: false, interactive: true });
    
    let output = '';
    vm.onStdout = (d) => { output += new TextDecoder().decode(d); process.stdout.write(new TextDecoder().decode(d)); };
    
    await vm.start();
    console.log('VM started, running curl...');
    const start = Date.now();
    await vm.writeToStdin('curl http://192.168.127.1:18888/ -o /tmp/100k.bin && ls -la /tmp/100k.bin && echo DONE\n');
    
    // Wait for DONE marker
    while (output.indexOf('DONE') === -1) {
        await new Promise(r => setTimeout(r, 100));
    }
    
    console.log('\nCompleted in', Date.now() - start, 'ms');
    console.log('Speed:', Math.round(size / (Date.now() - start)), 'KB/s');
    
    await vm.stop();
    server.close();
}
test().catch(console.error);
