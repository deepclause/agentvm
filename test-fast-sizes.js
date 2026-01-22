const { AgentVM } = require('./src/index');
const http = require('http');

// Test different file sizes WITHOUT throttling
const FILE_SIZES = [
  { name: '10KB', size: 10 * 1024 },
  { name: '50KB', size: 50 * 1024 },
  { name: '100KB', size: 100 * 1024 },
  { name: '500KB', size: 500 * 1024 },
  { name: '1MB', size: 1024 * 1024 },
];

async function createFastServer(fileSize) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const data = Buffer.alloc(fileSize, 'X');
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': fileSize,
      });
      res.end(data);
    });

    server.listen(0, '127.0.0.1', () => {
      resolve(server);
    });
  });
}

async function runTest(fileSize, sizeName) {
  const server = await createFastServer(fileSize);
  const port = server.address().port;

  const vm = new AgentVM({ network: true });
  await vm.start();

  const startTime = Date.now();
  const timeout = 30000; // 30s timeout for fast transfer

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
  console.log(`Testing FAST downloads (no throttling)\n`);
  console.log('Size\t\tResult\t\tTime');
  console.log('----\t\t------\t\t----');

  for (const { name, size } of FILE_SIZES) {
    process.stdout.write(`${name}\t\t`);
    
    try {
      const { completed, elapsed, error } = await runTest(size, name);
      
      if (completed) {
        console.log(`OK\t\t${(elapsed/1000).toFixed(1)}s`);
      } else {
        console.log(`${error || 'TIMEOUT'}\t\t${(elapsed/1000).toFixed(0)}s`);
      }
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
    }
  }
}

main().catch(console.error);
