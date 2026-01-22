/**
 * Download Monitor - Visibility into what's happening during downloads
 * 
 * Monitors:
 * - Network stack buffer sizes
 * - Data flow rates
 * - VM responsiveness
 */

const { AgentVM } = require('./src/index');

async function main() {
    const vm = new AgentVM({ network: true, debug: false });
    await vm.start();
    
    // Get access to internals for monitoring
    const netStack = vm._worker ? null : null; // We'll need to expose this
    
    console.log('Starting 5MB download with monitoring...\n');
    
    // Start download in background
    const downloadPromise = vm.exec('wget -O /tmp/dl http://speedtest.tele2.net/5MB.zip 2>&1; echo "EXIT:$?"');
    
    // Monitor progress by checking file size periodically
    let lastSize = 0;
    let stalled = 0;
    const startTime = Date.now();
    
    const monitor = setInterval(async () => {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        
        // Try to check file size (this might fail if VM is busy)
        try {
            const sizeResult = await Promise.race([
                vm.exec('stat -c %s /tmp/dl 2>/dev/null || echo 0'),
                new Promise((_, reject) => setTimeout(() => reject(new Error('stat timeout')), 2000))
            ]);
            const currentSize = parseInt(sizeResult.stdout.trim()) || 0;
            const rate = currentSize > lastSize ? ((currentSize - lastSize) / 1024).toFixed(0) : 0;
            
            console.log(`[${elapsed}s] File: ${(currentSize/1024/1024).toFixed(2)}MB, Rate: ${rate}KB/s`);
            
            if (currentSize === lastSize && currentSize > 0) {
                stalled++;
                if (stalled > 5) {
                    console.log('  -> Download appears stalled!');
                }
            } else {
                stalled = 0;
            }
            lastSize = currentSize;
        } catch (e) {
            console.log(`[${elapsed}s] VM busy - can't check status: ${e.message}`);
        }
    }, 1000);
    
    // Wait for download with timeout
    try {
        const result = await Promise.race([
            downloadPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 180000))
        ]);
        clearInterval(monitor);
        
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`\nDownload finished in ${elapsed}s`);
        console.log('Output:', result.stdout.substring(0, 500));
        
        // Check final file
        const finalSize = await vm.exec('wc -c < /tmp/dl 2>/dev/null || echo 0');
        console.log('Final size:', finalSize.stdout.trim(), 'bytes');
        
    } catch (e) {
        clearInterval(monitor);
        console.log('\nDownload failed:', e.message);
        
        // Try to get VM state
        console.log('\nTrying to check VM state...');
        try {
            const state = await Promise.race([
                vm.exec('ps aux; free -m; cat /proc/loadavg'),
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
            ]);
            console.log('VM State:', state.stdout);
        } catch (e2) {
            console.log('VM unresponsive:', e2.message);
        }
    }
    
    await vm.stop();
}

main().catch(console.error);
