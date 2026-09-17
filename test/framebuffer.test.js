// Virtual framebuffer (TinyEMU simplefb -> /dev/fb0) end-to-end.
//
// Guards the M0 path: the kernel binds the FDT simple-framebuffer, the AgentVM
// host creates /dev/fb0 at boot, guest code renders into it, and the host
// receives frames via onFramebuffer()/getFramebuffer() with the right pixels.
// The worker only pushes frames when the guest has written to the buffer
// (fb_dirty), so an idle VM produces none.
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

async function test() {
    const vm = new AgentVM();
    let failures = 0;
    const check = (name, ok, detail) => {
        console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
        if (!ok) failures++;
    };
    try {
        await withTimeout(vm.start(), 60000);

        const dev = await withTimeout(vm.exec('ls -l /dev/fb0; cat /sys/class/graphics/fb0/virtual_size'), 20000);
        check('/dev/fb0 exists', /\/dev\/fb0/.test(dev.stdout), dev.stdout.trim());
        check('kernel fb is 1024x768', /1024,768/.test(dev.stdout), dev.stdout.trim());

        let frames = 0;
        vm.onFramebuffer(() => { frames++; });

        await withTimeout(vm.exec(`cat > /tmp/fbdraw.py <<'PYEOF'\n${DRAW_PY}PYEOF\npython3 /tmp/fbdraw.py 2>&1`), 30000);
        await new Promise((r) => setTimeout(r, 800));

        check('onFramebuffer received frames', frames > 0, `frames=${frames}`);

        const fb = vm.getFramebuffer();
        check('getFramebuffer returns a frame', !!fb, fb ? '' : 'null');
        if (fb) {
            const px = (x, y) => { const i = (y * fb.width + x) * 4; return [fb.data[i], fb.data[i + 1], fb.data[i + 2], fb.data[i + 3]]; };
            const red = px(10, 10), green = px(500, 400), bg = px(900, 700);
            check('red square pixel', red[0] === 0 && red[1] === 0 && red[2] === 255 && red[3] === 255, red.join(','));
            check('green dot pixel', green[0] === 0 && green[1] === 255 && green[2] === 0 && green[3] === 255, green.join(','));
            check('untouched pixel stays black', bg.every((v) => v === 0), bg.join(','));
        }

        // Idle: no writes -> no frames pushed.
        const before = frames;
        await withTimeout(vm.exec('sleep 2'), 20000);
        await new Promise((r) => setTimeout(r, 400));
        check('idle VM pushes no frames (fb_dirty gating)', frames === before, `${before} -> ${frames}`);
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
