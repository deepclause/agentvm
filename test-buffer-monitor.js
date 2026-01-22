/**
 * Buffer monitoring test - see how buffers grow during fast transfer
 */

const { AgentVM } = require('./src/index');
const http = require('http');

function createFastServer(port) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const match = req.url.match(/\/bytes\/(\d+)/);
            if (match) {
                const size = parseInt(match[1]);
                res.writeHead(200, { 'Content-Length': size });
                // Send all at once (fast!)
                res.end(Buffer.alloc(size, 'x'));
            } else {
                res.writeHead(200);
                res.end('OK');
            }
        });
        server.listen(port, '0.0.0.0', () => resolve(server));
    });
}

async function main() {
    const server = await createFastServer(18080);
    
    const vm = new AgentVM({ network: true, debug: false });
    await vm.start();
    
    // Access internals to monitor buffer
    // The network stack is in the worker, we need to add monitoring
    
    console.log('Starting 500KB download and monitoring...');
    
    // Create a simple monitor that periodically tries to run commands
    const monitorResults = [];
    let downloadDone = false;
    
    // Start monitoring in parallel
    const monitorPromise = (async () => {
        while (!downloadDone) {
            const start = Date.now();
            try {
                // Quick command to test VM responsiveness
                const r = await Promise.race([
                    vm.exec('echo alive'),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 500))
                ]);
                monitorResults.push({ time: Date.now() - start, alive: true });
            } catch (e) {
                monitorResults.push({ time: Date.now() - start, alive: false });
            }
            await new Promise(r => setTimeout(r, 100)); // Check every 100ms
        }
    })();
    
    // Start download
    const start = Date.now();
    try {
        const result = await Promise.race([
            vm.exec('wget -q -O /dev/null http://192.168.127.1:18080/bytes/512000 && echo OK'),
            new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 15000))
        ]);
        downloadDone = true;
        console.log(`Download: ${result.stdout.trim()} in ${Date.now() - start}ms`);
    } catch (e) {
        downloadDone = true;
        console.log(`Download: ${e.message} in ${Date.now() - start}ms`);
    }
    
    await monitorPromise;
    
    console.log('\nVM responsiveness during download:');
    monitorResults.forEach((r, i) => {
        console.log(`  ${i}: ${r.alive ? 'alive' : 'BLOCKED'} (${r.time}ms)`);
    });
    
    await vm.stop();
    server.close();
}

main().catch(console.error);
