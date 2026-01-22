/**
 * Disk vs /dev/null Download Test
 * Uses local HTTP server for reliable testing
 */

const { AgentVM } = require('./src/index');
const http = require('http');

// Create a simple local server that serves random data
function createTestServer(port) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const match = req.url.match(/\/bytes\/(\d+)/);
            if (match) {
                const size = parseInt(match[1]);
                res.writeHead(200, { 'Content-Length': size });
                // Write in chunks to simulate real download
                let remaining = size;
                const chunkSize = 65536;
                const writeChunk = () => {
                    while (remaining > 0) {
                        const toWrite = Math.min(chunkSize, remaining);
                        const chunk = Buffer.alloc(toWrite, 'x');
                        if (!res.write(chunk)) {
                            remaining -= toWrite;
                            res.once('drain', writeChunk);
                            return;
                        }
                        remaining -= toWrite;
                    }
                    res.end();
                };
                writeChunk();
            } else {
                res.writeHead(404);
                res.end('Not found');
            }
        });
        server.listen(port, '0.0.0.0', () => resolve(server));
    });
}

async function main() {
    // Start local test server
    const server = await createTestServer(18080);
    console.log('Test server running on port 18080\n');
    
    const vm = new AgentVM({ network: true, debug: false });
    await vm.start();
    
    // Use gateway IP to reach host from VM
    const hostIP = '192.168.127.1';
    
    const tests = [
        { name: '1MB to /dev/null', cmd: `wget -q -O /dev/null http://${hostIP}:18080/bytes/1048576 && echo OK` },
        { name: '1MB to /tmp/dl', cmd: `wget -q -O /tmp/dl http://${hostIP}:18080/bytes/1048576 && wc -c < /tmp/dl && rm /tmp/dl` },
        { name: '3MB to /dev/null', cmd: `wget -q -O /dev/null http://${hostIP}:18080/bytes/3145728 && echo OK` },
        { name: '3MB to /tmp/dl', cmd: `wget -q -O /tmp/dl http://${hostIP}:18080/bytes/3145728 && wc -c < /tmp/dl && rm /tmp/dl` },
        { name: '5MB to /dev/null', cmd: `wget -q -O /dev/null http://${hostIP}:18080/bytes/5242880 && echo OK` },
        { name: '5MB to /tmp/dl', cmd: `wget -q -O /tmp/dl http://${hostIP}:18080/bytes/5242880 && wc -c < /tmp/dl && rm /tmp/dl`, timeout: 120000 },
        { name: '10MB to /dev/null', cmd: `wget -q -O /dev/null http://${hostIP}:18080/bytes/10485760 && echo OK`, timeout: 120000 },
    ];
    
    for (const test of tests) {
        process.stdout.write(`[${test.name}] ... `);
        const start = Date.now();
        try {
            const result = await Promise.race([
                vm.exec(test.cmd),
                new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), test.timeout || 60000))
            ]);
            const elapsed = Date.now() - start;
            console.log(`${result.stdout.trim()} (${elapsed}ms)`);
        } catch (e) {
            const elapsed = Date.now() - start;
            console.log(`${e.message} (${elapsed}ms)`);
        }
    }
    
    await vm.stop();
    server.close();
}

main().catch(console.error);
