/* global AudioWorkletProcessor, sampleRate, registerProcessor */
// Aida's microphone capture worklet (loaded by src/talk/voice.ts with audioWorklet.addModule).
// A real file rather than a Blob URL, so the site's Content-Security-Policy can stay script-src 'self'.
class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    // The size is kept apart from the buffer: once a buffer is posted (transferred) its length reads 0.
    this.size = Math.round(sampleRate * 0.1);
    this.buf = new Float32Array(this.size);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    let i = 0;
    while (i < ch.length) {
      const take = Math.min(this.size - this.n, ch.length - i);
      this.buf.set(ch.subarray(i, i + take), this.n);
      this.n += take;
      i += take;
      if (this.n === this.size) {
        // Loudness is measured here, on the audio thread, not on the page's.
        let sum = 0;
        for (let k = 0; k < this.size; k++) sum += this.buf[k] * this.buf[k];
        this.port.postMessage({ samples: this.buf, level: Math.sqrt(sum / this.size) }, [this.buf.buffer]);
        this.buf = new Float32Array(this.size);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor("aida-capture", Capture);
