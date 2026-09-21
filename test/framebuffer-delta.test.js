// Zero-reassembly framebuffer path: framebufferFull=false delivers damage
// rects only; the app blits them straight into its own surface with blitFrame().
const { AgentVM, blitFrame } = require('../src/index');

function withTimeout(promise, ms = 30000) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)),
    ]);
}

const DRAW_PY = `import mmap, time
W, H = 1024, 768
f = open('/dev/fb0', 'r+b')
m = mmap.mmap(f.fileno(), W * H * 4)
red = b'\\x00\\x00\\xff\\xff' * 100
for y in range(100):
    m[y*W*4:(y*W+100)*4] = red
i = (400*W + 500) * 4
m[i:i+4] = b'\\x00\\xff\\x00\\xff'
try:
    m.flush()
except OSError:
    pass
time.sleep(0.5)
m.close(); f.close()
print('drew')
`;

async function test() {
    const vm = new AgentVM({ framebufferFull: false });
    let failures = 0;
    const check = (name, ok, detail) => {
        console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
        if (!ok) failures++;
    };
    try {
        await withTimeout(vm.start(), 60000);

        const surface = new Uint8Array(1024 * 768 * 4);
        let frames = 0, rects = 0;
        vm.onFramebuffer((f) => {
            frames++;
            rects += f.rects ? f.rects.length : 0;
            // delta blit straight into the app surface
            blitFrame(surface, 1024 * 4, f);
            if (f.data !== null) check('frame.data is null in delta mode', false, typeof f.data);
        });

        await withTimeout(vm.exec(`cat > /tmp/fbdraw.py <<'PYEOF'\n${DRAW_PY}PYEOF\npython3 /tmp/fbdraw.py 2>&1`), 30000);
        await new Promise((r) => setTimeout(r, 800));

        check('delta mode: frames received', frames > 0, `frames=${frames}`);
        check('delta mode: rects present', rects > 0, `rects=${rects}`);
        check('delta mode: getFramebuffer() is null', vm.getFramebuffer() === null);

        const px = (x, y) => { const i = (y * 1024 + x) * 4; return [surface[i], surface[i + 1], surface[i + 2], surface[i + 3]]; };
        check('blitFrame: red square', px(10, 10).join(',') === '0,0,255,255', px(10, 10).join(','));
        check('blitFrame: green dot', px(500, 400).join(',') === '0,255,0,255', px(500, 400).join(','));
        check('blitFrame: untouched stays black', px(900, 700).every((v) => v === 0), px(900, 700).join(','));
    } catch (e) {
        console.error('TEST ERROR:', e);
        failures++;
    } finally {
        await vm.stop();
        console.log(failures === 0 ? '\nAll delta-framebuffer tests passed.' : `\n${failures} delta-framebuffer test(s) failed.`);
        if (failures) process.exit(1);
    }
}

test();
