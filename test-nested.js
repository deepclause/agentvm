const { AgentVM } = require('./src/index');

async function test() {
    const vm = new AgentVM({
        mounts: { '/mnt/data': './test-mount' }
    });
    await vm.start();
    
    console.log('Test 1: ls /mnt/data (top level)...');
    let res = await vm.exec('ls /mnt/data');
    console.log('Result:', res.stdout);
    
    console.log('\nTest 2: ls /mnt/data/downloads (1 level nested)...');
    res = await vm.exec('ls /mnt/data/downloads');
    console.log('Result:', res.stdout);
    
    console.log('\nTest 3: ls /mnt/data/downloads/subdir (2 levels nested)...');
    res = await vm.exec('ls /mnt/data/downloads/subdir');
    console.log('Result:', res);
    
    console.log('\nTest 4: cat a nested file...');
    res = await vm.exec('cat /mnt/data/downloads/test-download.txt');
    console.log('Result:', res);
    
    await vm.stop();
}
test().catch(e => { console.error('Error:', e); process.exit(1); });
