import { time } from './core.js';

export class Timeline {
  constructor(canvas, labels) {
    this.canvas = canvas; this.labels = labels; this.data = { cues: [] };
    new ResizeObserver(() => this.draw()).observe(canvas);
  }
  update(data) { this.data = data; this.draw(); }
  view() {
    if (this.lockedView) return this.lockedView;
    const { cues, activeId, playhead = 0 } = this.data, index = cues.findIndex(cue => cue.id === activeId);
    const nearby = index < 0 ? [] : cues.slice(Math.max(0, index - 1), index + 2);
    const fromCue = nearby.length ? Math.min(...nearby.map(cue => cue.start)) : playhead;
    const endCue = nearby.length ? Math.max(...nearby.map(cue => cue.end)) : playhead;
    const span = Math.max(16000, endCue - fromCue + 4000), from = Math.max(0, (fromCue + endCue - span) / 2);
    return { from, span };
  }
  at(clientX) {
    const rect = this.canvas.getBoundingClientRect(), { from, span } = this.view();
    return Math.max(0, Math.round(from + Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * span));
  }
  edge(clientX) {
    const cue = this.data.cues.find(item => item.id === this.data.activeId);
    if (!cue) return null;
    const rect = this.canvas.getBoundingClientRect(), { from, span } = this.view(), x = clientX - rect.left;
    const start = (cue.start - from) / span * rect.width, end = (cue.end - from) / span * rect.width;
    return Math.min(Math.abs(x - start), Math.abs(x - end)) <= 13 ? (Math.abs(x - start) < Math.abs(x - end) ? 'start' : 'end') : null;
  }
  draw() {
    const canvas = this.canvas, ctx = canvas.getContext('2d');
    if (!ctx) return;
    const width = canvas.clientWidth || 600, height = canvas.clientHeight || 86, scale = globalThis.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * scale) || canvas.height !== Math.round(height * scale)) { canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale); }
    ctx.setTransform(scale, 0, 0, scale, 0, 0); ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#090d0a'; ctx.fillRect(0, 0, width, height);
    const { from, span } = this.view(), { cues, activeId, peaks, duration, playhead = 0, message = '', candidate } = this.data;
    canvas.title = message || 'Waveform. Drag the active cue handles to adjust timing.';
    canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', canvas.title);
    const index = cues.findIndex(cue => cue.id === activeId), active = candidate ?? cues[index];
    ctx.strokeStyle = '#1f2a22'; ctx.lineWidth = 1;
    for (let i = 0; i <= 16; i++) { const x = width * i / 16; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke(); }
    if (peaks?.length && duration > 0) {
      ctx.strokeStyle = '#718278'; ctx.beginPath();
      for (let x = 0; x < width; x++) {
        const t = from + x / width * span;
        const peak = t <= duration ? peaks[Math.min(peaks.length - 1, Math.floor(t / duration * peaks.length))] || 0 : 0;
        ctx.moveTo(x, height / 2 - peak * height * .44); ctx.lineTo(x, height / 2 + peak * height * .44);
      }
      ctx.stroke();
    } else {
      ctx.fillStyle = '#738077'; ctx.font = '10px Consolas'; ctx.textAlign = 'left';
      ctx.fillText(message.length > 50 ? message.slice(0, 47) + '…' : message, 8, 17);
    }
    if (active) {
      for (const [offset, label] of [[-1, 'PREV'], [1, 'NEXT']]) {
        const cue = cues[index + offset]; if (!cue) continue;
        const left = Math.max(0, (cue.start - from) / span * width), right = Math.min(width, (cue.end - from) / span * width);
        ctx.fillStyle = 'rgba(111,147,130,.10)'; ctx.fillRect(left, 20, Math.max(0, right - left), height - 20);
        ctx.strokeStyle = 'rgba(133,164,149,.38)'; ctx.strokeRect(left + .5, 20.5, Math.max(0, right - left - 1), height - 21);
        ctx.fillStyle = '#71877b'; ctx.font = '9px Consolas'; ctx.textAlign = label === 'PREV' ? 'left' : 'right'; ctx.fillText(`${label} #${index + offset + 1}`, label === 'PREV' ? 6 : width - 6, 12);
      }
      const start = (active.start - from) / span * width, end = (active.end - from) / span * width;
      ctx.fillStyle = 'rgba(231,182,75,.11)'; ctx.fillRect(start, 0, end - start, height);
      for (const [x, text] of [[start, 'IN'], [end, 'OUT']]) {
        ctx.strokeStyle = '#e7b64b'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
        ctx.fillStyle = '#e7b64b'; ctx.fillRect(x - 17, height - 16, 34, 16); ctx.fillStyle = '#17130a'; ctx.font = 'bold 9px Consolas'; ctx.textAlign = 'center'; ctx.fillText(text, x, height - 5);
      }
    }
    const x = (playhead - from) / span * width;
    if (x >= 0 && x <= width) { ctx.strokeStyle = '#edf0e8'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke(); }
    ctx.fillStyle = '#738077'; ctx.font = '9px Consolas'; ctx.textAlign = 'left'; ctx.fillText(time(from), 6, height - 5); ctx.textAlign = 'right'; ctx.fillText(time(from + span), width - 6, height - 5);
    this.labels.window.textContent = `Prev · active · next / ${(span / 1000).toFixed(0)} seconds`;
    this.labels.previous.textContent = cues[index - 1] ? `PREV #${index} · ${time(cues[index - 1].start)} → ${time(cues[index - 1].end)}` : 'Previous —';
    this.labels.active.textContent = active ? `ACTIVE #${index + 1} · ${time(active.start)} → ${time(active.end)}` : 'Active —';
    this.labels.next.textContent = cues[index + 1] ? `NEXT #${index + 2} · ${time(cues[index + 1].start)} → ${time(cues[index + 1].end)}` : 'Next —';
  }
}
