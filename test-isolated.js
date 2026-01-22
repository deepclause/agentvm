/**
 * Isolated Download Test - Fresh VM for each test
 */

const { AgentVM } = require('./src/index');

async function testDownload(url, name, expectedSize, timeout = 30000) {
    const vm = new AgentVM({ network: true, debug: false });
    await vm.start();
    
    process.stdout.write(`[${name}] `);
    const start = Date.now();
    
    try {
        const result = await Promise.race([
            vm.exec(`wget -q -O /tmp/dl ${url} && wc -c < /tmp/dl && rm /tmp/dl`),
            new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), timeout))
        ]);
        const elapsed = Date.now() - start;
        const got = parseInt(result.stdout.trim()) || 0;
        const status = got === expectedSize ? 'PASS' : 'FAIL';
        console.log(`${status}: got ${got} bytes (expected ${expectedSize}) in ${elapsed}ms`);
        await vm.stop();
        return status === 'PASS';
    } catch (e) {
        const elapsed = Date.now() - start;
        console.log(`ERROR: ${e.message} after ${elapsed}ms`);
        await vm.stop();
        return false;
    }
}

async function main() {
    console.log('Testing downloads with fresh VM per test...\n');
    
    const tests = [
        { name: 'httpbin 50KB', url: 'http://httpbin.org/bytes/51200', expected: 51200 },
        { name: 'httpbin 100KB', url: 'http://httpbin.org/bytes/102400', expected: 102400 },
        { name: 'tele2 512KB', url: 'http://speedtest.tele2.net/512KB.zip', expected: 524288, timeout: 60000 },
        { name: 'tele2 1MB', url: 'http://speedtest.tele2.net/1MB.zip', expected: 1048576, timeout: 90000 },
    ];
    
    for (const test of tests) {
        await testDownload(test.url, test.name, test.expected, test.timeout || 30000);
    }
}

main().catch(console.error);
