'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AgentVM } = require('../src/index');

test('network toggle, firewall, and port-forward APIs work without booting the VM', async () => {
    const vm = new AgentVM({ network: true });

    assert.equal(vm.networkEnabled, true);
    vm.setNetworkEnabled(false);
    assert.equal(vm.networkEnabled, false);
    vm.setNetworkEnabled(true);
    assert.equal(vm.networkEnabled, true);

    vm.setFirewall({
        default: 'deny',
        rules: [
            { id: 'allow-ssh', direction: 'out', protocol: 'tcp', remote: '10.0.0.0/8', port: 22, action: 'allow' },
        ],
    });
    assert.equal(vm._matchFirewallSync('out', 'tcp', '10.0.0.5', 22), 'allow');
    assert.equal(vm._matchFirewallSync('out', 'tcp', '8.8.8.8', 443), 'deny');
    vm.clearFirewall();
    assert.equal(vm._matchFirewallSync('out', 'tcp', '8.8.8.8', 443), 'allow');

    assert.throws(() => vm._validatePortForward({ hostPort: 0, guestPort: 3000 }), /hostPort/);
    assert.throws(() => vm._validatePortForward({ hostPort: 3000, guestPort: 3000, protocol: 'udp' }), /TCP/);

    const forward = await vm.addPortForward({ hostPort: 19080, guestPort: 3000 });
    assert.equal(forward.guestHost, '192.168.127.3');
    assert.equal(vm.listPortForwards().length, 1);
    assert.equal(vm.removePortForward(19080), true);
    assert.equal(vm.listPortForwards().length, 0);
    assert.equal(vm.removePortForward(19080), false);

    await vm.stop();
});
