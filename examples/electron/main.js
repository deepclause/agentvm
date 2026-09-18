// Minimal Electron host: runs AgentVM, forwards guest audio to the renderer,
// and exposes exec() so the UI can start playback (e.g. aplay a WAV).
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const { AgentVM } = require('../../src/index.js');

let win = null;
let vm = null;

async function start() {
    win = new BrowserWindow({
        width: 900,
        height: 640,
        webPreferences: { preload: path.join(__dirname, 'preload.js') },
    });
    win.loadFile(path.join(__dirname, 'index.html'));

    vm = new AgentVM({ wasmPath: process.env.AGENTVM_WASM || undefined });
    vm.onAudio((a) => {
        if (win && !win.isDestroyed()) {
            win.webContents.send('audio', {
                sampleRate: a.sampleRate,
                channels: a.channels,
                data: a.data, // S16_LE interleaved
            });
        }
    });
    await vm.start();
    ipcMain.handle('exec', (_e, command) => vm.exec(command));
}

app.whenReady().then(start);
app.on('window-all-closed', async () => {
    if (vm) await vm.stop().catch(() => {});
    app.quit();
});
