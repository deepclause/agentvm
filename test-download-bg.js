/**
 * Download Monitor - Background download with VM-side monitoring
 * 
 * Runs wget in background and monitors via a script
 */

const { AgentVM } = require('./src/index');

async function main() {
    const vm = new AgentVM({ network: true, debug: false });
    await vm.start();
    
    console.log('Setting up background download with monitoring...\n');
    
    // Create a monitoring script that runs wget in background and reports progress
    const script = `
#!/bin/sh
# Start wget in background, redirect stderr to file for progress
wget -O /tmp/dl http://speedtest.tele2.net/5MB.zip 2>/tmp/wget.log &
WGET_PID=$!

echo "Started wget PID: $WGET_PID"

# Monitor until done
while kill -0 $WGET_PID 2>/dev/null; do
    SIZE=$(stat -c %s /tmp/dl 2>/dev/null || echo 0)
    MEM=$(free -m | awk '/Mem:/ {print $3"/"$2"MB"}')
    LOAD=$(cat /proc/loadavg | cut -d' ' -f1-3)
    echo "SIZE:$SIZE MEM:$MEM LOAD:$LOAD"
    sleep 1
done

# Final status
wait $WGET_PID
EXIT=$?
FINAL_SIZE=$(stat -c %s /tmp/dl 2>/dev/null || echo 0)
echo "DONE: exit=$EXIT size=$FINAL_SIZE"
cat /tmp/wget.log
`;

    // Write and run the script
    await vm.exec(`cat > /tmp/monitor.sh << 'SCRIPT'
${script}
SCRIPT`);
    await vm.exec('chmod +x /tmp/monitor.sh');
    
    console.log('Running download with monitoring...\n');
    
    const start = Date.now();
    try {
        const result = await Promise.race([
            vm.exec('sh /tmp/monitor.sh'),
            new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 180000))
        ]);
        
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        console.log(`\n=== Completed in ${elapsed}s ===`);
        console.log(result.stdout);
        
    } catch (e) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        console.log(`\nFailed after ${elapsed}s:`, e.message);
    }
    
    await vm.stop();
}

main().catch(console.error);
