const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('agentvm', {
    onAudio: (cb) => ipcRenderer.on('audio', (_e, a) => cb(a)),
    exec: (command) => ipcRenderer.invoke('exec', command),
});
