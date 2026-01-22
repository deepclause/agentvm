const { AgentVM } = require('./src/index');
const http = require('http');

// Test different file sizes with throttling
const FILE_SIZES = [
  { name: '100KB', size: 100 * 1024 },
  { name: '500KB', size: 500 * 1024 },
  { name: '1MB', size: 1024 * 1024 },
  { name: '5MB', size: 5 * 1024 * 1024 },
  { name: '10MB', size: 10 * 1024 * 1024 },
];

const CHUNK_SIZE = 1024;       // 1KB chunks
const CHUNK_DELAY = 10;        // 10ms between chunks

async function createThrottledServer(fileSize) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': fileSize,
      });

      let sent = 0;
      function sendChunk() {
        if (sent >= fileSize) {
          res.end();
          return;
        }
        const chunk = Buffer.alloc(Math.min(CHUNK_SIZE, fileSize - sent), 'X');
        sent += chunk.length;
        res.write(chunk);
        setTimeout(sendChunk, CHUNK_DELAY);
      }
      sendChunk();
    });

    server.listen(0, '127.0.0.1', () => {
      resolve(server);
    });
  });
}

async function runTest(fileSize, sizeName) {
  const server = await createThrottledServer(fileSize);
  const port = server.address().port;

  const vm = new AgentVM({ network: true });
  await vm.start();

  const startTime = Date.now();
  const timeout = Math.max(120000, fileSize / 50); // At least 120s, scale with size (for 10ms delay per 1KB)

  try {
    const result = await Promise.race([
      vm.exec(`wget -q -O /tmp/testfile http://192.168.127.1:${port}/ && ls -la /tmp/testfile && echo DONE`),
      new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), timeout))
    ]);
    
    const elapsed = Date.now() - startTime;
    const completed = result.stdout.includes('DONE');
    
    await vm.stop();
    server.close();
    
    return { completed, elapsed, result: result.stdout };
  } catch (err) {
    const elapsed = Date.now() - startTime;
    await vm.stop();
    server.close();
    return { completed: false, elapsed, error: err.message };
  }
}

async function main() {
  console.log(`Testing throttled downloads (${CHUNK_SIZE/1024}KB chunks, ${CHUNK_DELAY}ms delay)\n`);
  console.log('Size\t\tResult\t\tTime\t\tSpeed');
  console.log('----\t\t------\t\t----\t\t-----');

  for (const { name, size } of FILE_SIZES) {
    process.stdout.write(`${name}\t\t`);
    
    try {
      const { completed, elapsed, result } = await runTest(size, name);
      
      if (completed) {
        const speed = (size / 1024 / 1024) / (elapsed / 1000);
        console.log(`OK\t\t${(elapsed/1000).toFixed(1)}s\t\t${speed.toFixed(2)} MB/s`);
      } else {
        console.log(`TIMEOUT\t\t>${(elapsed/1000).toFixed(0)}s`);
      }
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
    }
  }
}

main().catch(console.error);
