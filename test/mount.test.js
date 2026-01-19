const { AgentVM } = require('../src/index');
const fs = require('fs');
const path = require('path');

const MOUNT_DIR = path.resolve(__dirname, '../test-mount');
const TEST_FILE_HOST = path.join(MOUNT_DIR, 'host_hello.txt');
const TEST_FILE_VM = path.join(MOUNT_DIR, 'vm_hello.txt');

function withTimeout(promise, ms = 5000) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms))
    ]);
}

async function test() {
    console.log("Initializing AgentVM with mount...");
    
    // Prepare host file
    fs.writeFileSync(TEST_FILE_HOST, 'Hello from Host');
    if (fs.existsSync(TEST_FILE_VM)) fs.unlinkSync(TEST_FILE_VM);

    const vm = new AgentVM({
        mounts: {
            '/mnt/data': MOUNT_DIR
        }
    });
    
    try {
        await withTimeout(vm.start(), 5000);
        console.log("VM Started.");

        console.log("Listing mounted directory...");
        let res = await withTimeout(vm.exec("ls /mnt/data"), 5000);
        console.log("Result:", JSON.stringify(res));
        if (!res.stdout.includes('host_hello.txt')) throw new Error("Mounted file not found");

        console.log("Reading host file from VM...");
        res = await withTimeout(vm.exec("cat /mnt/data/host_hello.txt"), 5000);
        console.log("Result:", JSON.stringify(res));
        if (res.stdout.trim() !== 'Hello from Host') throw new Error("Content mismatch");

        console.log("Writing to mounted directory from VM...");
        res = await withTimeout(vm.exec("echo 'Hello from VM' > /mnt/data/vm_hello.txt"), 5000);
        if (res.exitCode !== 0) throw new Error("Failed to write file");

        console.log("Verifying file on host...");
        if (!fs.existsSync(TEST_FILE_VM)) throw new Error("VM created file not found on host");
        const content = fs.readFileSync(TEST_FILE_VM, 'utf8');
        if (content.trim() !== 'Hello from VM') throw new Error("VM created file content mismatch");
        console.log("Host file check passed.");

    } catch (e) {
        console.error("TEST FAILED:", e);
        process.exit(1);
    } finally {
        await vm.stop();
        console.log("VM Stopped.");
        // Cleanup
        // fs.rmSync(MOUNT_DIR, { recursive: true, force: true });
    }
}

test();
