export class MediaController {
  constructor(element, onChange) {
    this.element = element; this.onChange = onChange; this.url = ''; this.token = 0;
    this.peaks = null; this.waveStatus = 'Open media to draw waveform'; this.name = ''; this.loaded = false;
    element.addEventListener('error', () => {
      this.loaded = false; this.waveStatus = 'This browser cannot play this media format.'; onChange('error');
    });
  }
  async open(file) {
    const token = ++this.token;
    this.element.pause(); this.loaded = false; this.peaks = null;
    this.name = file.name; this.waveStatus = 'Reading media…';
    const previous = this.url;
    this.url = URL.createObjectURL(file); this.element.src = this.url; this.element.load();
    if (previous) URL.revokeObjectURL(previous);
    this.onChange('loading', file);
    try {
      await new Promise((resolve, reject) => {
        const media = this.element;
        const done = callback => { clearTimeout(timer); media.removeEventListener('loadedmetadata', loaded); media.removeEventListener('error', failed); callback(); };
        const loaded = () => done(resolve), failed = () => done(() => reject(new Error('Unsupported media')));
        const timer = setTimeout(() => done(() => reject(new Error('Media loading timed out'))), 15000);
        media.addEventListener('loadedmetadata', loaded, { once: true }); media.addEventListener('error', failed, { once: true });
        if (media.readyState >= 1) loaded();
      });
      if (token !== this.token) return;
      this.loaded = true; this.onChange('loaded', file);
      await this.buildWaveform(file, token);
    } catch {
      if (token !== this.token) return;
      this.waveStatus = 'Media unavailable. Try a browser-supported audio or video file.'; this.onChange('error', file);
    }
  }
  async buildWaveform(file, token) {
    const estimate = this.element.duration * 48000 * 2 * 4;
    if (file.size > 96 * 1024 * 1024 || estimate > 256 * 1024 * 1024 || !Number.isFinite(estimate)) {
      this.waveStatus = 'Waveform skipped for this large file. Playback and timing controls still work.'; this.onChange('wave'); return;
    }
    let context;
    this.waveStatus = 'Preparing waveform…'; this.onChange('wave');
    try {
      const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AudioContextClass) throw new Error('Audio decoding unavailable');
      context = new AudioContextClass();
      const buffer = await context.decodeAudioData(await file.arrayBuffer());
      if (token !== this.token) return;
      const channel = buffer.getChannelData(0), buckets = Math.min(12000, channel.length), size = channel.length / buckets;
      const peaks = new Float32Array(buckets);
      for (let i = 0; i < buckets; i++) {
        const from = Math.floor(i * size), end = Math.min(channel.length, Math.ceil((i + 1) * size));
        for (let j = from; j < end; j += Math.max(1, Math.floor((end - from) / 50))) peaks[i] = Math.max(peaks[i], Math.abs(channel[j]));
      }
      this.peaks = peaks; this.waveStatus = '';
    } catch {
      if (token === this.token) this.waveStatus = 'Waveform unavailable for this codec. Playback and timing controls still work.';
    } finally {
      if (context) await context.close().catch(() => {});
      if (token === this.token) this.onChange('wave');
    }
  }
  async play() {
    if (!this.loaded) throw new Error('Open playable media first.');
    try { await this.element.play(); } catch { throw new Error('Playback could not start. Try another media format.'); }
  }
  seek(milliseconds) {
    if (!this.loaded) return false;
    this.element.currentTime = Math.max(0, Math.min(milliseconds / 1000, this.element.duration || 0));
    return true;
  }
  clear() {
    ++this.token; this.element.pause(); this.element.removeAttribute('src'); this.element.load();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = ''; this.loaded = false; this.peaks = null; this.name = ''; this.waveStatus = 'Open media to draw waveform';
  }
}
