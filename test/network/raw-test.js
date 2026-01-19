const { AgentVM } = require('../../src/index');

async function test() {
    console.log("Testing raw socket networking...");
    const vm = new AgentVM();
    
    try {
        await vm.start();
        console.log("VM Started.");
        
        // Create a Python script to test raw sockets
        const pythonScript = `
import socket
import struct

try:
    s = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.htons(0x0003))
    s.bind(('eth0', 0))
    print('Raw socket created successfully!')
    
    # Try to send an ARP request
    dst_mac = bytes([0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
    src_mac = bytes([0x02, 0x00, 0x00, 0x00, 0x00, 0x01])
    eth_type = struct.pack('!H', 0x0806)  # ARP
    
    # ARP request for 192.168.127.1
    arp = struct.pack('!HHBBH', 1, 0x0800, 6, 4, 1)  # hw, proto, hlen, plen, op
    arp += src_mac + bytes([192, 168, 127, 3])  # sender
    arp += bytes([0, 0, 0, 0, 0, 0]) + bytes([192, 168, 127, 1])  # target
    
    pkt = dst_mac + src_mac + eth_type + arp
    print(f'Sending ARP packet ({len(pkt)} bytes)...')
    sent = s.send(pkt)
    print(f'Sent {sent} bytes!')
    
    # Try to receive
    s.settimeout(3)
    try:
        data = s.recv(1500)
        print(f'Received {len(data)} bytes')
        print(f'Data (hex): {data.hex()}')
    except socket.timeout:
        print('No response (timeout)')
    
    s.close()
except Exception as e:
    print(f'Error: {e}')
    import traceback
    traceback.print_exc()
`;
        
        // Write the script to the VM
        let r = await vm.exec(`cat > /tmp/raw_test.py << 'ENDSCRIPT'
${pythonScript}
ENDSCRIPT`);
        console.log("Script written:", r.exitCode);
        
        // Run the script
        console.log("Running raw socket test...");
        r = await vm.exec("python3 /tmp/raw_test.py");
        console.log("Result:", r.stdout);
        if (r.stderr) console.log("Stderr:", r.stderr);
        
    } catch (e) {
        console.error("TEST FAILED:", e);
        process.exit(1);
    } finally {
        await vm.stop();
        console.log("VM Stopped.");
    }
}

test();
