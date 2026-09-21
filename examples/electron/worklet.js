// Queues interleaved Float32 PCM and plays it out at the audio device rate.
class PCMPlayer extends AudioWorkletProcessor {
    constructor() {
        super();
        this.channels = 2;
        this.queue = [];
        this.port.onmessage = (e) => { if (e.data.channels) this.channels = e.data.channels; this.queue.push(e.data.samples); };
    }
    process(_inputs, outputs) {
        const out = outputs[0];
        const frames = out[0].length;
        let written = 0;
        while (written < frames && this.queue.length) {
            const chunk = this.queue[0];
            const avail = chunk.length / this.channels;
            const n = Math.min(avail, frames - written);
            for (let c = 0; c < this.channels; c++) {
                const o = out[c] || out[0];
                for (let i = 0; i < n; i++) o[written + i] = chunk[i * this.channels + c] || 0;
            }
            if (n === avail) this.queue.shift();
            else this.queue[0] = chunk.subarray(n * this.channels);
            written += n;
        }
        return true;
    }
}
registerProcessor('pcm-player', PCMPlayer);
