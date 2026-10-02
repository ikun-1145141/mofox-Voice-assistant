// The microphone may run at 44.1 or 48 kHz. Resample its actual rate to 16 kHz.
// A persistent fractional cursor preserves timing across AudioWorklet blocks.
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = [];
    this.cursor = 0;
    this.step = sampleRate / 16000;
    this.frame = new Int16Array(320);
    this.frameIndex = 0;
    this.active = true;
    this.port.onmessage = (event) => {
      if (event.data === 'stop') {
        this.active = false;
        if (this.frameIndex) {
          const partial = this.frame.slice(0, this.frameIndex);
          this.port.postMessage(partial.buffer, [partial.buffer]);
        }
        this.port.postMessage('stopped');
      }
    };
  }

  process(inputs) {
    if (!this.active) return false;
    const channels = inputs[0];
    if (!channels?.[0]) return true;
    const length = channels[0].length;
    for (let i = 0; i < length; i++) {
      let mono = 0;
      for (const channel of channels) mono += channel[i] || 0;
      this.samples.push(mono / channels.length);
    }
    while (this.cursor + 1 < this.samples.length) {
      const left = Math.floor(this.cursor);
      const fraction = this.cursor - left;
      const value = this.samples[left] * (1 - fraction) + this.samples[left + 1] * fraction;
      const clipped = Math.max(-1, Math.min(1, value));
      this.frame[this.frameIndex++] = Math.round(clipped < 0 ? clipped * 32768 : clipped * 32767);
      if (this.frameIndex === this.frame.length) {
        const output = this.frame;
        this.port.postMessage(output.buffer, [output.buffer]);
        this.frame = new Int16Array(320);
        this.frameIndex = 0;
      }
      this.cursor += this.step;
    }
    // A 48 kHz cursor can advance past a 128-sample block. Preserve that
    // overshoot instead of resetting phase and accidentally emitting 16.125 kHz.
    const consumed = Math.min(Math.floor(this.cursor), this.samples.length);
    this.samples.splice(0, consumed);
    this.cursor -= consumed;
    return true;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
