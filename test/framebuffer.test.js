// Virtual framebuffer (simplefb -> /dev/fb0) + virtio-input, end-to-end.
//
// M1: the emulator reports damaged rectangles via fb_refresh(); the host
// accumulates them into a full frame. Idle VMs push nothing.
// M2: sendKey()/sendMouse() inject virtio-input events the guest reads from
// /dev/input/eventN.
const { AgentVM } = require('../src/index');

function withTimeout(promise, ms = 30000) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)),
    ]);
}

const DRAW_PY = `import mmap, time
W, H = 1024, 768
f = open('/dev/fb0', 'r+b')
m = mmap.mmap(f.fileno(), W * H * 4)   # char device: fstat size is 0
red = b'\\x00\\x00\\xff\\xff' * 100     # a8r8g8b8 little-endian = B,G,R,A
for y in range(100):
    m[y*W*4:(y*W+100)*4] = red
i = (400*W + 500) * 4
m[i:i+4] = b'\\x00\\xff\\x00\\xff'      # green dot
try:
    m.flush()
except OSError:
    pass
time.sleep(0.5)
m.close(); f.close()
print('drew')
`;

// Block for one key event on /dev/input/event0 and print its type/code/value.
const READKEY_PY = `import os, struct, select
fd = os.open('/dev/input/event0', os.O_RDONLY)
r, _, _ = select.select([fd], [], [], 5)
if r:
    d = os.read(fd, 24)
    t, c, v = struct.unpack('llHHi', d)[2:5]
    print('EV %d %d %d' % (t, c, v))
else:
    print('EV timeout')
os.close(fd)
`;

async function test() {
    const vm = new AgentVM();
    let failures = 0;
    const check = (name, ok, detail) => {
        console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
        if (!ok) failures++;
    };
    try {
        await withTimeout(vm.start(), 60000);

        const dev = await withTimeout(vm.exec('ls -l /dev/fb0 /dev/input/event0; cat /sys/class/graphics/fb0/virtual_size'), 20000);
        check('/dev/fb0 exists', /\/dev\/fb0/.test(dev.stdout), dev.stdout.split('\n')[0]);
        check('kernel fb is 1024x768', /1024,768/.test(dev.stdout), '');
        check('virtio keyboard node exists', /\/dev\/input\/event0/.test(dev.stdout), dev.stdout.split('\n')[1] || '');

        let frames = 0, rects = 0;
        vm.onFramebuffer((f) => { frames++; if (f.rects) rects += f.rects.length; });

        await withTimeout(vm.exec(`cat > /tmp/fbdraw.py <<'PYEOF'\n${DRAW_PY}PYEOF\npython3 /tmp/fbdraw.py 2>&1`), 30000);
        await new Promise((r) => setTimeout(r, 800));

        check('onFramebuffer received frames', frames > 0, `frames=${frames}`);
        check('frames carry damage rects (M1)', rects > 0, `rects=${rects}`);

        const fb = vm.getFramebuffer();
        check('getFramebuffer returns a frame', !!fb);
        if (fb) {
            const px = (x, y) => { const i = (y * fb.width + x) * 4; return [fb.data[i], fb.data[i + 1], fb.data[i + 2], fb.data[i + 3]]; };
            const red = px(10, 10), green = px(500, 400), bg = px(900, 700);
            check('red square pixel', red.join(',') === '0,0,255,255', red.join(','));
            check('green dot pixel', green.join(',') === '0,255,0,255', green.join(','));
            check('untouched pixel stays black', bg.every((v) => v === 0), bg.join(','));
        }

        // Idle: no writes -> no frames pushed.
        const before = frames;
        await withTimeout(vm.exec('sleep 2'), 20000);
        await new Promise((r) => setTimeout(r, 400));
        check('idle VM pushes no frames', frames === before, `${before} -> ${frames}`);

        // M2: send a key and read it back from the guest.
        await withTimeout(vm.exec(`cat > /tmp/readkey.py <<'PYEOF'\n${READKEY_PY}PYEOF`), 20000);
        const keyP = vm.exec('python3 /tmp/readkey.py 2>&1');
        await new Promise((r) => setTimeout(r, 1000));
        vm.sendKey('ArrowLeft', true);
        const keyRes = await withTimeout(keyP, 20000);
        check('guest received the key (M2)', /EV 1 105 1/.test(keyRes.stdout), keyRes.stdout.trim());

        // Mouse event accepted without throwing.
        let mouseOk = true;
        try { vm.sendMouse(512, 384, 1); } catch (e) { mouseOk = false; }
        check('sendMouse accepted', mouseOk);
    } catch (e) {
        console.error('TEST ERROR:', e);
        failures++;
    } finally {
        await vm.stop();
        console.log(failures === 0 ? '\nAll framebuffer tests passed.' : `\n${failures} framebuffer test(s) failed.`);
        if (failures) process.exit(1);
    }
}

test();
