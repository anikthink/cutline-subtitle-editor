export const PROJECT_FORMAT = 'cutline-project';
export const PROJECT_VERSION = 1;
export const MIN_DURATION = 50;

export function uid() {
  return globalThis.crypto?.randomUUID?.() ?? `cue-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function parseTime(value) {
  const match = String(value).trim().match(/^(\d{1,6}):(\d{2}):(\d{2})[,.](\d{1,3})$/);
  if (!match || +match[2] > 59 || +match[3] > 59) return NaN;
  return +match[1] * 3600000 + +match[2] * 60000 + +match[3] * 1000 + +match[4].padEnd(3, '0');
}

export function time(value, comma = false) {
  const total = Math.max(0, Math.round(Number(value) || 0));
  const hours = Math.floor(total / 3600000);
  const minutes = Math.floor(total % 3600000 / 60000);
  const seconds = Math.floor(total % 60000 / 1000);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}${comma ? ',' : '.'}${String(total % 1000).padStart(3, '0')}`;
}

export function validTiming(cue) {
  return Number.isSafeInteger(cue.start) && Number.isSafeInteger(cue.end) && cue.start >= 0 && cue.end > cue.start;
}

export function parseSrt(raw) {
  const text = String(raw).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const cues = [], errors = [], warnings = [];
  const blocks = text.split(/\n[ \t]*\n/);
  let line = 1;
  for (let block = 0; block < blocks.length; block++) {
    const content = blocks[block];
    const lines = content.split('\n');
    const leading = lines.findIndex(item => item.trim());
    const firstLine = line + Math.max(leading, 0);
    line += lines.length + 1;
    if (!content.trim()) continue;
    const items = lines.slice(Math.max(leading, 0));
    const timingIndex = /^\d+$/.test(items[0].trim()) ? 1 : 0;
    const match = items[timingIndex]?.trim().match(/^(\S+)\s*-->\s*(\S+)\s*$/);
    if (!match) {
      errors.push({ block: block + 1, line: firstLine + timingIndex, message: 'Missing or unsupported timing line.' });
      continue;
    }
    const start = parseTime(match[1]), end = parseTime(match[2]);
    if (!validTiming({ start, end })) {
      errors.push({ block: block + 1, line: firstLine + timingIndex, message: 'Use valid timestamps with an end after the start.' });
      continue;
    }
    cues.push({ id: uid(), start, end, text: items.slice(timingIndex + 1).join('\n').trim(), reviewed: false, reference: '' });
  }
  if (cues.some((cue, index) => index && cue.start < cues[index - 1].start)) {
    warnings.push('Timings are not in chronological order. The original row order will be kept.');
  }
  return { cues, errors, warnings };
}

export function serializeSrt(cues) {
  if (cues.some(cue => !validTiming(cue))) throw new Error('Correct invalid timings before exporting.');
  return cues.map((cue, index) => `${index + 1}\r\n${time(cue.start, true)} --> ${time(cue.end, true)}\r\n${cue.text.trim()}\r\n`).join('\r\n');
}

export function createProject(title = 'Untitled project', cues = [], fileName = '') {
  const now = Date.now();
  return { format: PROJECT_FORMAT, version: PROJECT_VERSION, id: uid(), title: title.trim() || 'Untitled project', fileName,
    createdAt: now, updatedAt: now, revision: 0, cues, media: null, referenceName: '' };
}

export function validateProject(input) {
  if (!input || input.format !== PROJECT_FORMAT || input.version !== PROJECT_VERSION) throw new Error('This is not a supported Cutline project backup.');
  if (!Array.isArray(input.cues) || input.cues.length > 100000) throw new Error('The project must contain an array of up to 100,000 cues.');
  const ids = new Set();
  const cues = input.cues.map((cue, index) => {
    if (!cue || !validTiming(cue) || typeof cue.text !== 'string' || typeof cue.id !== 'string' || !cue.id || ids.has(cue.id)) {
      throw new Error(`Cue ${index + 1} has invalid timing, text, or a duplicate ID.`);
    }
    ids.add(cue.id);
    return { id: cue.id, start: cue.start, end: cue.end, text: cue.text, reviewed: cue.reviewed === true, reference: typeof cue.reference === 'string' ? cue.reference : '' };
  });
  const project = createProject(typeof input.title === 'string' ? input.title.slice(0, 200) : 'Recovered project', cues,
    typeof input.fileName === 'string' ? input.fileName : '');
  project.id = typeof input.id === 'string' && input.id ? input.id : project.id;
  project.createdAt = Number.isFinite(input.createdAt) ? input.createdAt : project.createdAt;
  project.updatedAt = Number.isFinite(input.updatedAt) ? input.updatedAt : project.updatedAt;
  project.revision = Number.isSafeInteger(input.revision) && input.revision >= 0 ? input.revision : 0;
  project.referenceName = typeof input.referenceName === 'string' ? input.referenceName : '';
  if (input.media && typeof input.media.name === 'string') {
    project.media = { name: input.media.name, size: Number(input.media.size) || 0, type: String(input.media.type || ''), lastModified: Number(input.media.lastModified) || 0 };
  }
  return project;
}

export function analyzeCues(cues) {
  const results = new Map(cues.map(cue => [cue.id, []]));
  const ordered = [...cues].sort((a, b) => a.start - b.start);
  let previous = null;
  for (const cue of ordered) {
    if (previous && previous.end > cue.start) {
      for (const item of [previous, cue]) if (!results.get(item.id).includes('Overlaps another cue')) results.get(item.id).push('Overlaps another cue');
    }
    if (!previous || cue.end > previous.end) previous = cue;
  }
  for (const cue of cues) {
    const issues = results.get(cue.id), duration = cue.end - cue.start;
    if (!validTiming(cue)) issues.push('End must be after start');
    if (duration < 450) issues.push('Duration under 450 ms');
    if (duration > 8000) issues.push('Duration over 8 seconds');
    const metrics = cueMetrics(cue);
    if (metrics.cps > 21) issues.push(`Fast reading speed: ${metrics.cps.toFixed(1)} cps`);
    if (metrics.longest > 44) issues.push(`Long line: ${metrics.longest} characters`);
    if (!cue.text.trim()) issues.push('Empty subtitle');
  }
  return results;
}

export function cueMetrics(cue) {
  const count = value => Array.from(value).length;
  return { duration: cue.end - cue.start, cps: count(cue.text.replace(/\s/g, '')) / Math.max(.001, (cue.end - cue.start) / 1000), longest: Math.max(0, ...cue.text.split('\n').map(count)) };
}

export function activeCueAt(cues, milliseconds) {
  let active = null;
  for (const cue of cues) if (cue.start <= milliseconds && milliseconds < cue.end && (!active || cue.start > active.start)) active = cue;
  return active;
}

export function shiftCues(cues, ids, offset) {
  if (!Number.isSafeInteger(offset)) throw new Error('The offset must be a whole number of milliseconds.');
  const selected = cues.filter(cue => ids.has(cue.id));
  const applied = selected.length ? Math.max(offset, -Math.min(...selected.map(cue => cue.start))) : 0;
  return { applied, cues: cues.map(cue => ids.has(cue.id) ? { ...cue, start: cue.start + applied, end: cue.end + applied } : cue) };
}

export function fixOverlap(cues, id) {
  const cue = cues.find(item => item.id === id);
  if (!cue) throw new Error('Select a cue first.');
  const index = cues.indexOf(cue);
  const previous = cues.filter((item, i) => item.id !== id && (item.start < cue.start || (item.start === cue.start && i < index)) && item.end > cue.start);
  if (!previous.length) throw new Error('This cue has no preceding overlap.');
  const start = Math.max(...previous.map(item => item.end)) + 20;
  if (cue.end - start < MIN_DURATION) throw new Error('There is no room for a valid correction. Adjust these timings manually.');
  return cues.map(item => item.id === id ? { ...item, start } : item);
}

export function cleanText(text) {
  return text.replace(/[ \t]+([,.;!?])/g, '$1').replace(/\.{3,}/g, '…').split('\n').map(line => line.replace(/[ \t]{2,}/g, ' ').trim()).join('\n').trim();
}

export class History {
  constructor(limit = 60, maxBytes = 16 * 1024 * 1024) { this.limit = limit; this.maxBytes = maxBytes; this.undo = []; this.redo = []; }
  push(snapshot, label) {
    this.undo.push({ snapshot: structuredClone(snapshot), label }); this.redo = [];
    while (this.undo.length > this.limit || (this.undo.length > 1 && JSON.stringify(this.undo).length > this.maxBytes)) this.undo.shift();
  }
  move(direction, current) {
    const from = this[direction], to = this[direction === 'undo' ? 'redo' : 'undo'];
    const entry = from.pop();
    if (!entry) return null;
    to.push({ snapshot: structuredClone(current), label: entry.label });
    return structuredClone(entry.snapshot);
  }
}
