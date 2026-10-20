import { uid, parseTime, time, parseSrt, serializeSrt, createProject, validateProject, analyzeCues, cueMetrics, activeCueAt, shiftCues, fixOverlap, cleanText, validTiming, History, MIN_DURATION } from './core.js';
import { ProjectStore } from './storage.js';
import { MediaController } from './media.js';
import { CueList } from './cue-list.js';
import { Timeline } from './timeline.js';

const els = Object.fromEntries([...document.querySelectorAll('[id]')].map(element => [element.id, element]));
const store = new ProjectStore();
const state = { project: createProject(), activeId: null, selection: new Set(), anchor: null, issues: new Map(), history: new History(),
  dirty: false, saveTimer: null, textSession: null, textTimer: null, playingId: null, follow: true, drag: null, pendingImport: null, replayEnd: null, ready: false };
let backedUp = null, renderTimer, filterKey = '', projectSwitch = 0;

const escape = text => String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const activeCue = () => state.project.cues.find(cue => cue.id === state.activeId);
const snapshot = () => ({ cues: structuredClone(state.project.cues), title: state.project.title, fileName: state.project.fileName, referenceName: state.project.referenceName, activeId: state.activeId, selection: [...state.selection], anchor: state.anchor });
const timeline = new Timeline(els.wave, { window: els.waveWindow, previous: els.prevWaveCue, active: els.activeWaveCue, next: els.nextWaveCue });
const list = new CueList(els.cueList, ({ cue, index }) => {
  const issues = state.issues.get(cue.id) || [], selected = state.selection.has(cue.id), active = cue.id === state.activeId;
  return `<article class="cue-row ${selected ? 'selected' : ''} ${active ? 'active' : ''} ${cue.id === state.playingId ? 'playing' : ''} ${issues.length ? 'issue' : ''} ${cue.reviewed ? 'reviewed' : ''}" role="option" aria-selected="${selected}" aria-posinset="${index + 1}" aria-setsize="${state.project.cues.length}" aria-label="Cue ${index + 1}${issues.length ? ', has warnings' : ''}${cue.reviewed ? ', reviewed' : ''}" tabindex="${active ? 0 : -1}" data-id="${escape(cue.id)}">
    <div class="cue-no">${String(index + 1).padStart(3, '0')}</div><div><div class="cue-time">${time(cue.start)} → ${time(cue.end)}</div><div class="cue-text">${escape(cue.text)}</div></div><div class="review-dot" title="${cue.reviewed ? 'Reviewed' : 'Unreviewed'}"></div></article>`;
});

function notice(message) { els.noticeText.textContent = message; els.notice.hidden = false; }
function toast(message) { els.toast.textContent = message; els.toast.classList.add('on'); clearTimeout(toast.timer); toast.timer = setTimeout(() => els.toast.classList.remove('on'), 2500); }
function safe(action) { return async event => { try { await action(event); } catch (error) { notice(error.message || 'The action could not finish. Your current project is still open.'); } }; }
function closeMenu() { els.projectMenu.open = false; }
function setSaveState(text, color = 'var(--muted)') { els.saveState.textContent = text; els.saveState.style.color = color; }
function finishText() { clearTimeout(state.textTimer); state.textSession = null; }
function timingError(message, field) {
  els.timingError.textContent = message; els.timingError.hidden = !message;
  for (const input of [els.startField, els.endField]) input.setAttribute('aria-invalid', String(Boolean(message && (!field || input === field))));
}
function touch() {
  state.project = { ...state.project, revision: state.project.revision + 1, updatedAt: Math.max(Date.now(), state.project.updatedAt + 1) };
  state.dirty = true;
  const journaled = store.journal(state.project);
  setSaveState(journaled ? 'Saving…' : 'Unsaved', 'var(--signal)');
  clearTimeout(state.saveTimer); state.saveTimer = setTimeout(() => saveNow().catch(error => notice(error.message)), 200);
}
async function saveNow() {
  clearTimeout(state.saveTimer);
  const project = state.project;
  if (!state.ready) return;
  try {
    const result = await store.save(project);
    if (state.project.id === project.id && state.project.revision === project.revision) {
      state.dirty = false; setSaveState(result.backend === 'IndexedDB' ? 'Saved on this device' : 'Saved in browser storage', 'var(--ok)');
    }
  } catch (error) {
    if (state.project.id === project.id) { state.dirty = true; setSaveState('Save needs attention', 'var(--danger)'); }
    throw error;
  }
}
async function preserveCurrent() {
  finishText();
  try { await saveNow(); } catch (error) {
    if (backedUp?.id !== state.project.id || backedUp.revision !== state.project.revision) throw new Error(error.message + ' Download a project backup before switching projects.');
  }
}

function repairSelection() {
  const ids = new Set(state.project.cues.map(cue => cue.id));
  state.selection = new Set([...state.selection].filter(id => ids.has(id)));
  if (!ids.has(state.activeId)) state.activeId = state.project.cues[0]?.id ?? null;
  if (!state.selection.size && state.activeId) state.selection.add(state.activeId);
  if (!ids.has(state.anchor)) state.anchor = state.activeId;
}
function transact(label, updater) {
  finishText();
  const before = snapshot();
  const previousProject = state.project;
  try {
    updater();
    if (state.project.cues.some(cue => !validTiming(cue))) throw new Error('The edit would create an invalid subtitle timing.');
  } catch (error) { state.project = previousProject; throw error; }
  const after = snapshot();
  if (JSON.stringify(before) === JSON.stringify(after)) return false;
  state.history.push(before, label); repairSelection(); touch(); refresh(); return true;
}
function history(direction) {
  finishText();
  const entry = state.history.move(direction, snapshot());
  if (!entry) return;
  state.project = { ...state.project, cues: entry.cues, title: entry.title, fileName: entry.fileName, referenceName: entry.referenceName };
  state.activeId = entry.activeId; state.selection = new Set(entry.selection); state.anchor = entry.anchor;
  repairSelection(); timingError(''); touch(); refresh(); list.reveal(state.activeId);
}
function selectCue(id, mode = 'replace', reveal = true) {
  if (!state.project.cues.some(cue => cue.id === id)) return;
  finishText(); timingError('');
  if (mode === 'range') {
    const all = state.project.cues, from = Math.max(0, all.findIndex(cue => cue.id === (state.anchor || state.activeId))), to = all.findIndex(cue => cue.id === id);
    state.selection = new Set(all.slice(Math.min(from, to), Math.max(from, to) + 1).map(cue => cue.id));
  } else if (mode === 'toggle') {
    if (state.selection.has(id) && state.selection.size > 1) state.selection.delete(id); else state.selection.add(id);
    state.anchor = id;
  } else { state.selection = new Set([id]); state.anchor = id; }
  state.activeId = id; renderList(); renderInspector(); renderStatus(); drawWave();
  if (reveal) list.reveal(id);
}
function moveCue(amount) {
  const ids = list.rows.map(row => row.cue.id);
  if (!ids.length) return;
  const index = ids.indexOf(state.activeId);
  selectCue(ids[Math.max(0, Math.min(ids.length - 1, index + amount))]);
}

function renderList() {
  const query = els.search.value.trim().toLocaleLowerCase(), filter = els.filter.value;
  const key = `${query}:${filter}`;
  const rows = state.project.cues.map((cue, index) => ({ cue, index })).filter(({ cue, index }) => {
    if (query && !`${index + 1} ${cue.text}`.toLocaleLowerCase().includes(query)) return false;
    if (filter === 'issues' && !state.issues.get(cue.id)?.length) return false;
    if (filter === 'reviewed' && !cue.reviewed) return false;
    if (filter === 'unreviewed' && cue.reviewed) return false;
    return true;
  });
  list.setRows(rows, filterKey !== key); filterKey = key;
}
function metric(element, value, bad = false) { element.querySelector('b').textContent = value; element.classList.toggle('bad', bad); }
function renderInspector(keepInput = false) {
  const cue = activeCue();
  for (const element of [els.startField, els.endField, els.textField, els.nudgeBack, els.nudgeForward, els.cleanupText, els.reviewBtn]) element.disabled = !cue;
  for (const element of [els.seekCue, els.setStart, els.setEnd, els.replayBtn]) element.disabled = !cue || !media.loaded;
  els.fixOverlap.disabled = ![...state.issues.values()].some(issues => issues.includes('Overlaps another cue'));
  els.jumpIssue.disabled = ![...state.issues.values()].some(issues => issues.length);
  if (!cue) {
    els.activeNumber.textContent = '—'; els.activeRange.textContent = 'No cue selected';
    for (const element of [els.startField, els.endField, els.textField, els.referenceText]) element.value = '';
    for (const element of [els.durationMetric, els.cpsMetric, els.lineMetric]) metric(element, '—');
    els.issuesList.innerHTML = '<div class="issue-chip ok">Open subtitles or add a cue to start.</div>'; els.reviewBtn.textContent = 'Mark reviewed'; return;
  }
  const index = state.project.cues.indexOf(cue);
  els.activeNumber.textContent = `#${index + 1}`;
  els.activeRange.textContent = `${time(cue.start)} — ${time(cue.end)}${state.selection.size > 1 ? ` · ${state.selection.size} selected` : ''}`;
  if (!keepInput || document.activeElement !== els.startField) els.startField.value = time(cue.start);
  if (!keepInput || document.activeElement !== els.endField) els.endField.value = time(cue.end);
  if (!keepInput || document.activeElement !== els.textField) els.textField.value = cue.text;
  els.referenceText.value = cue.reference || '';
  els.reviewBtn.textContent = cue.reviewed ? 'Mark unreviewed' : 'Mark reviewed';
  const metrics = cueMetrics(cue);
  metric(els.durationMetric, `${(metrics.duration / 1000).toFixed(2)}s`, metrics.duration < 450 || metrics.duration > 8000);
  metric(els.cpsMetric, metrics.cps.toFixed(1), metrics.cps > 21); metric(els.lineMetric, metrics.longest, metrics.longest > 44);
  const issues = state.issues.get(cue.id) || [];
  els.issuesList.innerHTML = issues.length ? issues.map(issue => `<div class="issue-chip">${escape(issue)}</div>`).join('') : '<div class="issue-chip ok">Cue passes timing and readability checks.</div>';
}
function renderStatus() {
  const cues = state.project.cues, selected = state.selection.size;
  els.statusCues.textContent = cues.length; els.statusSelected.textContent = selected;
  els.statusIssues.textContent = [...state.issues.values()].filter(issues => issues.length).length;
  els.statusReviewed.textContent = cues.length ? `${Math.round(cues.filter(cue => cue.reviewed).length / cues.length * 100)}%` : '0%';
  els.selectionStatus.innerHTML = `<strong>${selected} selected</strong>`;
  els.shiftBtn.textContent = selected > 1 ? `Shift ${selected} cues` : 'Bulk shift'; els.shiftBtn.disabled = !selected;
  els.deleteCueBtn.textContent = selected > 1 ? `Delete ${selected} cues` : 'Delete selected'; els.deleteCueBtn.disabled = !selected;
  els.selectAllBtn.disabled = !cues.length; els.clearSelectionBtn.disabled = !state.activeId;
  els.undoBtn.disabled = !state.history.undo.length; els.redoBtn.disabled = !state.history.redo.length;
  els.exportBtn.disabled = !cues.length;
  els.fileName.textContent = state.project.title; els.fileName.title = state.project.fileName || state.project.title;
  els.followBtn.setAttribute('aria-pressed', String(state.follow));
  document.title = `${state.project.title} — Cutline`;
}
function refresh(keepInput = false) {
  clearTimeout(renderTimer); state.issues = analyzeCues(state.project.cues); renderList(); renderInspector(keepInput); renderStatus(); tick();
}
function drawWave() {
  timeline.update({ cues: state.project.cues, activeId: state.activeId, playhead: Math.round((els.media.currentTime || 0) * 1000), duration: media.loaded ? els.media.duration * 1000 : 0,
    peaks: media.peaks, message: media.waveStatus, candidate: state.drag?.candidate });
}
function tick() {
  const t = Math.round((els.media.currentTime || 0) * 1000);
  els.currentTime.textContent = els.statusPosition.textContent = time(t);
  els.duration.textContent = media.loaded ? time(els.media.duration * 1000) : time(0);
  els.scrub.value = media.loaded && els.media.duration ? t / (els.media.duration * 1000) * 1000 : 0;
  const playing = activeCueAt(state.project.cues, t);
  els.subtitleOverlay.textContent = media.loaded ? playing?.text ?? '' : '';
  if (state.playingId !== playing?.id) {
    state.playingId = playing?.id ?? null; list.version++; list.render();
    if (state.follow && media.loaded && !els.media.paused && playing) list.reveal(playing.id, true);
  }
  if (state.replayEnd !== null && t >= state.replayEnd) { els.media.pause(); state.replayEnd = null; }
  drawWave();
}
const media = new MediaController(els.media, (event, file) => {
  els.playBtn.disabled = !media.loaded; els.scrub.disabled = !media.loaded; els.rate.disabled = !media.loaded;
  if (event === 'loading') { els.emptyCallout.hidden = true; els.audioPoster.classList.toggle('on', file.type.startsWith('audio/') || /\.(wav|mp3|m4a|ogg|flac)$/i.test(file.name)); }
  if (event === 'loaded') {
    els.media.playbackRate = parseFloat(els.rate.value);
    state.project = { ...state.project, media: { name: file.name, size: file.size, type: file.type, lastModified: file.lastModified } }; touch();
    toast(`Media opened: ${file.name}`);
  }
  if (event === 'error') {
    els.emptyCallout.hidden = false; els.audioPoster.classList.remove('on');
    els.emptyCallout.replaceChildren(); const strong = document.createElement('strong'); strong.textContent = 'Media could not be opened';
    els.emptyCallout.append(strong, 'Try an audio or video format supported by your browser. Your subtitles are still available.');
    notice(media.waveStatus);
  }
  renderInspector(true); tick();
});

async function openProject(project, message = '') {
  const token = ++projectSwitch;
  await preserveCurrent();
  if (token !== projectSwitch) return;
  media.clear(); state.project = validateProject(project); state.history = new History(); state.activeId = project.cues[0]?.id ?? null;
  state.selection = new Set(state.activeId ? [state.activeId] : []); state.anchor = state.activeId; state.playingId = null; state.dirty = false;
  els.search.value = ''; els.filter.value = 'all'; timingError(''); els.projectDialog.close(); closeMenu();
  mediaPlaceholder(); refresh(); await saveNow(); if (message) toast(message);
}
function mediaPlaceholder() {
  els.emptyCallout.hidden = false; els.audioPoster.classList.remove('on'); els.emptyCallout.replaceChildren();
  const strong = document.createElement('strong'); strong.textContent = state.project.media ? 'Reopen your media' : 'Open video or audio';
  els.emptyCallout.append(strong, state.project.media ? `Choose “${state.project.media.name}” to continue previewing. Subtitles and review progress are saved.` : 'Choose a media file supported by your browser. Your files stay on this device.');
  els.playBtn.disabled = true; els.scrub.disabled = true; els.rate.disabled = true;
}
function fileName(extension) { return (state.project.fileName || state.project.title || 'subtitles').replace(/\.(srt|json)$/i, '').replace(/\.cutline$/i, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') + extension; }
function download(content, name, type) {
  const url = URL.createObjectURL(new Blob([content], { type })), anchor = document.createElement('a');
  anchor.href = url; anchor.download = name; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
}
function exportBackup() {
  finishText(); download(JSON.stringify(state.project, null, 2), fileName('.cutline.json'), 'application/json;charset=utf-8');
  backedUp = { id: state.project.id, revision: state.project.revision }; closeMenu(); toast('Project backup downloaded');
}
async function prepareImport(file, kind) {
  if (file.size > 20 * 1024 * 1024) throw new Error('Subtitle files must be smaller than 20 MB.');
  const report = parseSrt(await file.text());
  if (!report.cues.length && !report.errors.length) throw new Error('This subtitle file is empty.');
  if (report.errors.length || report.warnings.length) {
    state.pendingImport = { report, fileName: file.name, kind };
    els.importSummary.textContent = `${report.cues.length} valid cues; ${report.errors.length} rejected blocks.`;
    els.importDetails.replaceChildren();
    for (const text of [...report.warnings, ...report.errors.slice(0, 30).map(error => `Block ${error.block}, line ${error.line}: ${error.message}`)]) {
      const li = document.createElement('li'); li.textContent = text; els.importDetails.append(li);
    }
    if (report.errors.length > 30) { const li = document.createElement('li'); li.textContent = `And ${report.errors.length - 30} more rejected blocks.`; els.importDetails.append(li); }
    els.confirmImport.disabled = !report.cues.length;
    els.confirmImport.textContent = report.errors.length ? 'Import valid cues' : 'Import cues'; els.importDialog.showModal();
  } else await applyImport(report, file.name, kind);
}
async function applyImport(report, name, kind) {
  if (kind === 'reference') {
    transact('Load reference subtitles', () => {
      state.project = { ...state.project, referenceName: name, cues: state.project.cues.map((cue, index) => ({ ...cue, reference: report.cues[index]?.text ?? '' })) };
    });
    notice(`Reference matched to the current row order: ${Math.min(report.cues.length, state.project.cues.length)} cues. Reference text stays with each cue when rows are inserted or deleted.`);
  } else {
    const project = createProject(name.replace(/\.srt$/i, ''), report.cues, name);
    await openProject(project, `Imported ${report.cues.length} cues`);
  }
}

function addCue() {
  const cues = state.project.cues, active = activeCue(); let at = cues.length, start = 0;
  if (media.loaded) { start = Math.round(els.media.currentTime * 1000); at = cues.findIndex(cue => cue.start > start); if (at < 0) at = cues.length; }
  else if (active) { at = cues.indexOf(active) + 1; start = active.end + 100; }
  const next = cues[at]; let end = start + 2000;
  if (next && next.start > start + MIN_DURATION + 20) end = Math.min(end, next.start - 20);
  const cue = { id: uid(), start, end, text: '', reviewed: false, reference: '' };
  transact('Add cue', () => { const items = [...cues]; items.splice(at, 0, cue); state.project = { ...state.project, cues: items }; state.activeId = cue.id; state.selection = new Set([cue.id]); state.anchor = cue.id; });
  list.reveal(cue.id); els.textField.focus({ preventScroll: true });
}
function deleteSelected() {
  if (!state.selection.size) return;
  const index = state.project.cues.findIndex(cue => state.selection.has(cue.id));
  transact('Delete cues', () => {
    const cues = state.project.cues.filter(cue => !state.selection.has(cue.id)); state.project = { ...state.project, cues };
    state.activeId = cues[Math.min(index, cues.length - 1)]?.id ?? null; state.selection = new Set(state.activeId ? [state.activeId] : []); state.anchor = state.activeId;
  });
  toast('Cues deleted. Undo is available.');
}
function shiftSelected(offset, ids = state.selection) {
  const shifted = shiftCues(state.project.cues, ids, offset);
  if (!shifted.applied) return;
  transact('Shift timing', () => { state.project = { ...state.project, cues: shifted.cues }; });
  toast(`Shifted ${ids.size} cue${ids.size === 1 ? '' : 's'} ${Math.abs(shifted.applied)} ms ${shifted.applied < 0 ? 'earlier' : 'later'}`);
}
function changeTiming(which, value) {
  const cue = activeCue(); if (!cue) return;
  const next = { ...cue, [which]: value };
  if (!validTiming(next) || next.end - next.start < MIN_DURATION) throw new Error('Use a non-negative start and an end at least 50 ms later.');
  transact('Edit timing', () => { state.project = { ...state.project, cues: state.project.cues.map(item => item.id === cue.id ? next : item) }; }); timingError('');
}

els.dismissNotice.onclick = () => { els.notice.hidden = true; };
els.openMedia.onclick = () => els.mediaInput.click(); els.openSrt.onclick = () => els.srtInput.click(); els.openReference.onclick = () => els.referenceInput.click();
els.openBackup.onclick = () => { closeMenu(); els.backupInput.click(); };
els.saveBackup.onclick = exportBackup;
els.mediaInput.onchange = safe(async event => { const file = event.target.files[0]; event.target.value = ''; if (file) { finishText(); await media.open(file); } });
for (const [input, kind] of [[els.srtInput, 'subtitles'], [els.referenceInput, 'reference']]) input.onchange = safe(async event => {
  const file = event.target.files[0]; event.target.value = ''; if (file) await prepareImport(file, kind);
});
els.backupInput.onchange = safe(async event => {
  const file = event.target.files[0]; event.target.value = ''; if (!file) return;
  if (file.size > 50 * 1024 * 1024) throw new Error('Project backups must be smaller than 50 MB.');
  let data; try { data = JSON.parse(await file.text()); } catch { throw new Error('This file is not valid project JSON.'); }
  const project = validateProject(data); project.id = uid(); project.revision = 0; project.createdAt = project.updatedAt = Date.now();
  await openProject(project, 'Backup opened as a separate project');
});
els.cancelImport.onclick = () => { state.pendingImport = null; els.importDialog.close(); };
els.confirmImport.onclick = safe(async () => {
  const pending = state.pendingImport; if (!pending?.report.cues.length) return;
  await applyImport(pending.report, pending.fileName, pending.kind); state.pendingImport = null; els.importDialog.close();
});
els.manageProjects.onclick = safe(async () => {
  closeMenu(); finishText(); els.projectTitle.value = state.project.title;
  const projects = await store.list(); els.recentProjects.replaceChildren();
  for (const project of projects) {
    const button = document.createElement('button'); button.className = 'btn'; button.type = 'button';
    const name = document.createElement('span'); name.textContent = project.title;
    const detail = document.createElement('small'); detail.textContent = `${project.cues.length} cues · ${new Date(project.updatedAt).toLocaleString()}`;
    name.append(detail); button.append(name); button.onclick = safe(() => openProject(project, 'Project opened')); els.recentProjects.append(button);
  }
  if (!projects.length) els.recentProjects.textContent = 'Your projects will appear here after the first edit.';
  els.projectDialog.showModal();
});
els.closeProjects.onclick = () => els.projectDialog.close();
els.newProject.onclick = safe(async () => { await openProject(createProject(els.projectTitle.value), 'New project created'); });
els.renameProject.onclick = safe(() => {
  const title = els.projectTitle.value.trim(); if (!title) throw new Error('Enter a project name.');
  transact('Rename project', () => { state.project = { ...state.project, title }; }); els.projectDialog.close();
});
els.undoBtn.onclick = () => history('undo'); els.redoBtn.onclick = () => history('redo');
els.addCueBtn.onclick = safe(addCue); els.deleteCueBtn.onclick = safe(deleteSelected);
els.selectAllBtn.onclick = () => { finishText(); state.selection = new Set(list.rows.map(row => row.cue.id)); renderList(); renderStatus(); renderInspector(); };
els.clearSelectionBtn.onclick = () => { state.selection = new Set(state.activeId ? [state.activeId] : []); renderList(); renderStatus(); renderInspector(); };
els.cueList.onclick = event => { const row = event.target.closest('.cue-row'); if (row) selectCue(row.dataset.id, event.shiftKey ? 'range' : event.ctrlKey || event.metaKey ? 'toggle' : 'replace', false); };
els.cueList.addEventListener('keydown', event => {
  const ids = list.rows.map(row => row.cue.id); let index = ids.indexOf(state.activeId);
  if (event.key === 'ArrowDown') index++; else if (event.key === 'ArrowUp') index--;
  else if (event.key === 'Home') index = 0; else if (event.key === 'End') index = ids.length - 1;
  else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); if (event.target.dataset.id) selectCue(event.target.dataset.id); return; }
  else return;
  event.preventDefault(); event.stopPropagation(); const id = ids[Math.max(0, Math.min(ids.length - 1, index))];
  if (id) { selectCue(id, event.shiftKey ? 'range' : 'replace'); els.cueList.querySelector(`[data-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true }); }
});
els.search.oninput = () => { renderList(); }; els.filter.onchange = () => { renderList(); };
els.followBtn.onclick = () => { state.follow = !state.follow; renderStatus(); toast(`Follow playback ${state.follow ? 'on' : 'off'}`); };
els.textField.oninput = () => {
  const cue = activeCue(); if (!cue || cue.text === els.textField.value) return;
  if (state.textSession !== cue.id) { state.history.push(snapshot(), 'Edit text'); state.textSession = cue.id; }
  state.project = { ...state.project, cues: state.project.cues.map(item => item.id === cue.id ? { ...item, text: els.textField.value } : item) }; touch();
  clearTimeout(state.textTimer); state.textTimer = setTimeout(finishText, 1200);
  clearTimeout(renderTimer); renderTimer = setTimeout(() => refresh(true), 100);
};
els.textField.onblur = () => { finishText(); refresh(true); };
for (const [field, which] of [[els.startField, 'start'], [els.endField, 'end']]) field.onchange = () => {
  try { const value = parseTime(field.value); if (!Number.isFinite(value)) throw new Error('Enter a timestamp as HH:MM:SS.mmm, with minutes and seconds below 60.'); changeTiming(which, value); }
  catch (error) { timingError(error.message, field); }
};
els.seekCue.onclick = () => { const cue = activeCue(); if (cue) { media.seek(cue.start); tick(); } };
els.setStart.onclick = safe(() => changeTiming('start', Math.round(els.media.currentTime * 1000)));
els.setEnd.onclick = safe(() => changeTiming('end', Math.round(els.media.currentTime * 1000)));
els.nudgeBack.onclick = safe(() => shiftSelected(-100)); els.nudgeForward.onclick = safe(() => shiftSelected(100));
els.cleanupText.onclick = safe(() => { const cue = activeCue(); if (cue) transact('Clean punctuation', () => { state.project = { ...state.project, cues: state.project.cues.map(item => item.id === cue.id ? { ...item, text: cleanText(item.text) } : item) }; }); });
els.reviewBtn.onclick = safe(() => { const cue = activeCue(); if (cue) transact('Change review status', () => { state.project = { ...state.project, cues: state.project.cues.map(item => item.id === cue.id ? { ...item, reviewed: !item.reviewed } : item) }; }); });
els.exportBtn.onclick = safe(() => { finishText(); if (!state.project.cues.length) return; download('\uFEFF' + serializeSrt(state.project.cues), fileName('.srt'), 'application/x-subrip;charset=utf-8'); toast('SRT downloaded'); });
els.shiftBtn.onclick = () => { finishText(); els.shiftScope.options[0].textContent = `Selected cues (${state.selection.size})`; els.shiftDialog.showModal(); };
els.shiftAmount.step = '1';
els.shiftForm.onsubmit = event => {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault();
  try {
    const offset = Number(els.shiftAmount.value); if (!Number.isSafeInteger(offset)) throw new Error('Enter a whole number of milliseconds.');
    let ids = state.selection;
    if (els.shiftScope.value === 'all') ids = new Set(state.project.cues.map(cue => cue.id));
    if (els.shiftScope.value === 'forward') ids = new Set(state.project.cues.slice(Math.max(0, state.project.cues.findIndex(cue => cue.id === state.activeId))).map(cue => cue.id));
    shiftSelected(offset, ids); els.shiftDialog.close();
  } catch (error) { notice(error.message); }
};
els.jumpIssue.onclick = () => {
  const cues = state.project.cues, index = cues.findIndex(cue => cue.id === state.activeId);
  for (let step = 1; step <= cues.length; step++) { const cue = cues[(index + step) % cues.length]; if (state.issues.get(cue.id)?.length) { selectCue(cue.id); return; } }
};
els.fixOverlap.onclick = safe(() => {
  for (const cue of [...state.project.cues].sort((a, b) => a.start - b.start)) {
    try {
      const cues = fixOverlap(state.project.cues, cue.id);
      transact('Fix overlap', () => { state.project = { ...state.project, cues }; state.activeId = cue.id; state.selection = new Set([cue.id]); }); list.reveal(cue.id); return;
    } catch { /* Try the next cue; never create an invalid correction. */ }
  }
  throw new Error('These overlaps need manual timing edits; there is no room for a valid automatic correction.');
});
els.prevCue.onclick = () => moveCue(-1); els.nextCue.onclick = () => moveCue(1);
els.playBtn.onclick = safe(async () => { state.replayEnd = null; if (els.media.paused) await media.play(); else els.media.pause(); });
els.replayBtn.onclick = safe(async () => { const cue = activeCue(); if (!cue) return; media.seek(Math.max(0, cue.start - 200)); state.replayEnd = cue.end; await media.play(); });
els.scrub.oninput = () => { state.replayEnd = null; media.seek(Number(els.scrub.value) / 1000 * els.media.duration * 1000); tick(); };
els.rate.onchange = () => { els.media.playbackRate = parseFloat(els.rate.value); };
els.media.addEventListener('timeupdate', tick);
els.media.addEventListener('play', () => { els.playBtn.textContent = 'Ⅱ'; els.playBtn.setAttribute('aria-label', 'Pause'); });
els.media.addEventListener('pause', () => { els.playBtn.textContent = '▶'; els.playBtn.setAttribute('aria-label', 'Play'); });
els.stage.addEventListener('dragover', event => event.preventDefault());
els.stage.addEventListener('drop', safe(async event => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) await media.open(file); }));
els.wave.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  finishText(); const edge = timeline.edge(event.clientX), cue = activeCue();
  if (!edge || !cue) { media.seek(timeline.at(event.clientX)); tick(); return; }
  state.drag = { id: cue.id, edge, candidate: { ...cue } }; timeline.lockedView = timeline.view(); els.wave.setPointerCapture(event.pointerId); event.preventDefault();
});
els.wave.addEventListener('pointermove', event => {
  if (!state.drag) return;
  const drag = state.drag, value = timeline.at(event.clientX);
  drag.candidate = { ...drag.candidate, [drag.edge]: drag.edge === 'start' ? Math.min(value, drag.candidate.end - MIN_DURATION) : Math.max(value, drag.candidate.start + MIN_DURATION) };
  drawWave();
});
els.wave.addEventListener('pointerup', safe(() => {
  if (!state.drag) return; const drag = state.drag; state.drag = null; timeline.lockedView = null;
  transact('Drag timing', () => { state.project = { ...state.project, cues: state.project.cues.map(cue => cue.id === drag.id ? drag.candidate : cue) }; });
}));
els.wave.addEventListener('pointercancel', () => { state.drag = null; timeline.lockedView = null; drawWave(); });

window.addEventListener('keydown', event => {
  if (!state.ready || document.querySelector('dialog[open]')) return;
  const editing = event.target.matches('input,textarea,select,[contenteditable=true]'), mod = event.ctrlKey || event.metaKey;
  if (mod && event.key.toLowerCase() === 's') { event.preventDefault(); exportBackup(); return; }
  if (mod && event.key.toLowerCase() === 'z') { event.preventDefault(); history(event.shiftKey ? 'redo' : 'undo'); return; }
  if (mod && event.key.toLowerCase() === 'y') { event.preventDefault(); history('redo'); return; }
  if (editing || event.altKey || (event.target.matches('button,summary,a') && [' ', 'Enter'].includes(event.key))) return;
  if (mod && event.key.toLowerCase() === 'a') { event.preventDefault(); els.selectAllBtn.click(); return; }
  if (mod) return;
  if (event.code === 'Space') { event.preventDefault(); els.playBtn.click(); }
  else if (event.key === 'Insert') { event.preventDefault(); els.addCueBtn.click(); }
  else if (event.key === 'Delete') { event.preventDefault(); els.deleteCueBtn.click(); }
  else if (event.key.toLowerCase() === 'j') moveCue(-1); else if (event.key.toLowerCase() === 'k') moveCue(1);
  else if (event.key === '[') els.setStart.click(); else if (event.key === ']') els.setEnd.click();
  else if (event.key === 'Enter') els.replayBtn.click();
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault(); const direction = event.key === 'ArrowLeft' ? -1 : 1;
    if (event.shiftKey) safe(() => shiftSelected(direction * 100))(); else { media.seek(els.media.currentTime * 1000 + direction * 500); tick(); }
  }
});
window.addEventListener('beforeunload', event => { if (state.dirty && !store.journal(state.project)) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('pagehide', () => { if (state.dirty) store.journal(state.project); });
document.addEventListener('visibilitychange', () => { if (document.hidden && state.dirty) { store.journal(state.project); saveNow().catch(() => {}); } });

window.cutlineReady = (async () => {
  for (const button of document.querySelectorAll('button')) button.disabled = true;
  await store.open();
  try {
    const recovered = await store.last();
    if (recovered) {
      state.project = recovered; state.activeId = recovered.cues[0]?.id ?? null; state.selection = new Set(state.activeId ? [state.activeId] : []); state.anchor = state.activeId;
      setSaveState('Project recovered', 'var(--ok)');
    } else setSaveState('Ready');
  } catch (error) { notice('Could not read browser storage. Download backups while editing. ' + error.message); setSaveState('Storage needs attention', 'var(--danger)'); }
  state.ready = true;
  for (const button of document.querySelectorAll('button')) button.disabled = false;
  if (!store.db && !store.journalAvailable) notice('Autosave is unavailable in this browser. Save project backups to keep your edits.');
  mediaPlaceholder(); refresh(); els.app.setAttribute('aria-busy', 'false');
  document.dispatchEvent(new CustomEvent('cutline:ready'));
})();
