import { validateProject } from './core.js';

const DATABASE = 'cutline-projects-v1';
const JOURNAL_PREFIX = 'cutline-recovery-v1:';
const SESSION_KEY = 'cutline-last-project-v1';

export class ConflictError extends Error {}

export class ProjectStore {
  constructor() {
    this.db = null; this.queue = Promise.resolve(); this.baselines = new Map();
    this.writer = globalThis.crypto?.randomUUID?.() ?? String(Math.random());
    this.journalAvailable = true; this.idbAvailable = true;
  }
  async open() {
    try {
      this.db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(DATABASE, 1);
        const timer = setTimeout(() => reject(new Error('Storage did not respond.')), 5000);
        request.onupgradeneeded = () => { request.result.createObjectStore('projects', { keyPath: 'id' }); request.result.createObjectStore('meta'); };
        request.onsuccess = () => { clearTimeout(timer); resolve(request.result); };
        request.onerror = () => { clearTimeout(timer); reject(request.error); };
        request.onblocked = () => { clearTimeout(timer); reject(new Error('Storage is blocked by another tab.')); };
      });
      this.db.onversionchange = () => this.db.close();
    } catch { this.idbAvailable = false; }
    try { localStorage.setItem('cutline-storage-check', '1'); localStorage.removeItem('cutline-storage-check'); } catch { this.journalAvailable = false; }
    return this;
  }
  journal(project) {
    try {
      localStorage.setItem(JOURNAL_PREFIX + project.id + ':' + this.writer, JSON.stringify({ project, writer: this.writer }));
      localStorage.setItem(SESSION_KEY, project.id);
      this.journalAvailable = true;
      return true;
    } catch { this.journalAvailable = false; return false; }
  }
  journals() {
    const items = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key?.startsWith(JOURNAL_PREFIX)) continue;
        try { const item = JSON.parse(localStorage.getItem(key)); items.push({ ...item, project: validateProject(item.project), key }); } catch { /* A corrupt recovery entry must not hide other projects. */ }
      }
    } catch { this.journalAvailable = false; }
    return items;
  }
  async list() {
    let stored = [];
    if (this.db) stored = await new Promise((resolve, reject) => {
      const tx = this.db.transaction('projects', 'readonly'); const request = tx.objectStore('projects').getAll();
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const records = new Map();
    for (const raw of stored) {
      try { const project = validateProject(raw); records.set(project.id, project); if (!this.baselines.has(project.id)) this.baselines.set(project.id, project.revision); } catch { /* Invalid stored records are not opened automatically. */ }
    }
    for (const item of this.journals()) {
      const previous = records.get(item.project.id);
      if (!previous || item.project.updatedAt > previous.updatedAt) records.set(item.project.id, item.project);
    }
    return [...records.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async last() {
    const projects = await this.list();
    let lastId;
    try { lastId = localStorage.getItem(SESSION_KEY); } catch { /* IndexedDB still works without localStorage. */ }
    if (!lastId && this.db) lastId = await new Promise(resolve => {
      const request = this.db.transaction('meta', 'readonly').objectStore('meta').get('last');
      request.onsuccess = () => resolve(request.result); request.onerror = () => resolve(null);
    });
    return projects.find(item => item.id === lastId) ?? projects[0] ?? null;
  }
  save(project) {
    const copy = structuredClone(project);
    const journaled = this.journal(copy);
    const task = this.queue.catch(() => {}).then(async () => {
      if (!this.db) {
        if (!journaled) throw new Error('Browser storage is unavailable. Save a project backup to keep your work.');
        return { backend: 'localStorage' };
      }
      await new Promise((resolve, reject) => {
        const tx = this.db.transaction(['projects', 'meta'], 'readwrite');
        const table = tx.objectStore('projects'), request = table.get(copy.id);
        let problem;
        request.onsuccess = () => {
          const existing = request.result;
          const expected = this.baselines.get(copy.id) ?? 0;
          if (existing && (existing.revision > copy.revision || (existing.revision > expected && existing.writer !== this.writer))) {
            problem = new ConflictError('This project changed in another tab. Save a project backup before reopening it.'); tx.abort(); return;
          }
          if (!existing || existing.revision <= copy.revision) table.put({ ...copy, writer: this.writer });
          tx.objectStore('meta').put(copy.id, 'last');
        };
        tx.oncomplete = () => { this.baselines.set(copy.id, Math.max(copy.revision, this.baselines.get(copy.id) ?? 0)); resolve(); };
        tx.onabort = () => reject(problem ?? tx.error ?? new Error('Autosave was interrupted.'));
        tx.onerror = () => reject(problem ?? tx.error);
      });
      // Retain this window's recovery entry for immediate close/reload recovery.
      try {
        for (const item of this.journals()) if (item.project.id === copy.id && item.writer !== this.writer && item.project.updatedAt <= copy.updatedAt && item.project.revision <= copy.revision) localStorage.removeItem(item.key);
      } catch { /* A completed IndexedDB transaction remains successful. */ }
      return { backend: 'IndexedDB' };
    });
    this.queue = task;
    return task;
  }
}
