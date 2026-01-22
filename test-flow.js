/**
 * Network Flow Debug - Track data flow through the network stack
 */

const { AgentVM } = require('./src/index');
const net = require('net');

// Patch to intercept network activity
let dataFromHost = 0;
let dataToVM = 0;
let lastReport = Date.now();

async function main() {
    const vm = new AgentVM({ network: true, debug: false });
    
    await vm.start();
    
    // First test: simple small download to verify network works
    console.log('Test 1: Small download (100KB)...');
    let start = Date.now();
    let result = await vm.exec('wget -q -O /dev/null http://httpbin.org/bytes/102400 && echo OK');
    console.log(`  Result: ${result.stdout.trim()} in ${Date.now() - start}ms\n`);
    
    // Test 2: 1MB download  
    console.log('Test 2: 1MB download...');
    start = Date.now();
    result = await Promise.race([
        vm.exec('wget -q -O /dev/null http://speedtest.tele2.net/1MB.zip && echo OK'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 60000))
    ]).catch(e => ({ stdout: e.message, exitCode: -1 }));
    console.log(`  Result: ${result.stdout.trim()} in ${Date.now() - start}ms\n`);
    
    // Test 3: 3MB download
    console.log('Test 3: 3MB download...');
    start = Date.now();
    result = await Promise.race([
        vm.exec('wget -q -O /dev/null http://speedtest.tele2.net/3MB.zip && echo OK'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 90000))
    ]).catch(e => ({ stdout: e.message, exitCode: -1 }));
    console.log(`  Result: ${result.stdout.trim()} in ${Date.now() - start}ms\n`);
    
    // Test 4: 5MB download
    console.log('Test 4: 5MB download...');
    start = Date.now();
    result = await Promise.race([
        vm.exec('wget -q -O /dev/null http://speedtest.tele2.net/5MB.zip && echo OK'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 120000))
    ]).catch(e => ({ stdout: e.message, exitCode: -1 }));
    console.log(`  Result: ${result.stdout.trim()} in ${Date.now() - start}ms\n`);
    
    await vm.stop();
}

main().catch(console.error);
