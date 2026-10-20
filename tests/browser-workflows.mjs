// Open /tests/browser.html through the development server in a disposable browser profile.
import { createProject } from '../src/core.js';
import { ProjectStore, ConflictError } from '../src/storage.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function assert(value, message) { if (!value) throw new Error(message); }
async function until(check, message, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(40); }
  throw new Error(message);
}
export async function runWorkflows(frame) {
  const results = [];
  let doc, win;
  const el = id => doc.getElementById(id);
  const input = (id, value, event = 'input') => { el(id).value = value; el(id).dispatchEvent(new win.Event(event, { bubbles: true })); };
  const click = id => el(id).click();
  async function load(url = '/') {
    const loaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }));
    frame.src = url; await loaded; win = frame.contentWindow; doc = win.document;
    await until(() => Boolean(win.cutlineReady), 'App did not initialize'); await win.cutlineReady;
  }
  async function upload(id, contents, name) {
    const data = new win.DataTransfer(); data.items.add(new win.File([contents], name, { type: 'text/plain' }));
    el(id).files = data.files; el(id).dispatchEvent(new win.Event('change', { bubbles: true })); await delay(350);
  }
  async function saved() { await until(() => el('saveState').textContent.startsWith('Saved'), 'Save did not complete: ' + el('noticeText').textContent); }
  function captureDownloads() {
    const blobs = [];
    const create = win.URL.createObjectURL.bind(win.URL);
    win.URL.createObjectURL = blob => { blobs.push(blob); return create(blob); };
    const original = win.HTMLAnchorElement.prototype.click;
    win.HTMLAnchorElement.prototype.click = function () { if (!this.download) return original.call(this); };
    return blobs;
  }
  await load();
  click('manageProjects'); await until(() => el('projectDialog').open, 'Projects did not open');
  const testTitle = 'Browser checks ' + Date.now(); input('projectTitle', testTitle); click('newProject');
  await until(() => el('fileName').textContent === testTitle && !el('projectDialog').open, 'Test project not created');
  click('addCueBtn'); el('textField').focus(); input('textField', 'বাংলা subtitle\nSaved while still typing');
  // Reload before the debounce and blur handlers can save. The synchronous journal must recover it.
  await load('/?reload=text');
  assert(el('textField').value === 'বাংলা subtitle\nSaved while still typing', 'Focused text lost on immediate reload');
  results.push('Focused text survives immediate reload');

  click('reviewBtn'); assert(el('reviewBtn').textContent === 'Mark unreviewed', 'Review action failed');
  click('undoBtn'); assert(el('reviewBtn').textContent === 'Mark reviewed', 'Review undo failed');
  click('redoBtn'); assert(el('reviewBtn').textContent === 'Mark unreviewed', 'Review redo failed');
  input('startField', '00:99:00.000', 'change');
  assert(!el('timingError').hidden && el('startField').getAttribute('aria-invalid') === 'true', 'Invalid timing was accepted');
  input('startField', '00:00:00.000', 'change');
  assert(el('timingError').hidden, 'Valid timing did not clear error');
  results.push('Review undo/redo and strict timing validation');

  await upload('referenceInput', '1\n00:00:00,000 --> 00:00:02,000\nReference line\n', 'reference.srt');
  assert(el('referenceText').value === 'Reference line', 'Reference not attached');
  const downloads = captureDownloads(); click('saveBackup'); click('exportBtn');
  const backup = JSON.parse(await downloads[0].text()), srt = await downloads[1].text();
  assert(backup.cues[0].reviewed && backup.cues[0].reference === 'Reference line', 'Backup lost review/reference');
  assert(srt.includes('বাংলা subtitle\nSaved while still typing'), 'Export lost live text or Unicode');
  click('selectAllBtn'); click('deleteCueBtn'); await saved();
  await load('/?reload=empty');
  assert(el('statusCues').textContent === '0' && el('textField').disabled, 'Deleted cues returned after reload');
  await upload('backupInput', JSON.stringify(backup), 'backup.cutline.json');
  assert(el('statusCues').textContent === '1' && el('reviewBtn').textContent === 'Mark unreviewed' && el('referenceText').value === 'Reference line', 'Backup restore failed');
  results.push('SRT export, project backup restore, and delete-all recovery');

  const partial = '1\n00:00:03,000 --> 00:00:05,000\nValid import\n\n2\n00:00:09,000 --> 00:00:08,000\nRejected\n';
  await upload('srtInput', partial, 'partial.srt');
  assert(el('importDialog').open && el('importSummary').textContent === '1 valid cues; 1 rejected blocks.', 'Partial import was silent');
  click('cancelImport'); assert(el('textField').value === backup.cues[0].text, 'Cancelled import changed project');
  await upload('srtInput', partial, 'partial.srt'); click('confirmImport');
  await until(() => !el('importDialog').open && el('fileName').textContent === 'partial', 'Confirmed import did not finish'); await saved();
  assert(el('textField').value === 'Valid import', 'Confirmed valid block not imported');
  results.push('Malformed SRT requires explicit partial import confirmation');

  // Exercise the actual virtualized list, including the last row and filtered navigation.
  const time = ms => { const s = Math.floor(ms / 1000); return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };
  const large = Array.from({ length: 10000 }, (_, i) => `${i + 1}\n${time(i * 2500)} --> ${time(i * 2500 + 2000)}\nDialogue ${i + 1}\n`).join('\n');
  await upload('srtInput', large, 'large.srt'); await saved(); await delay(250);
  assert(el('statusCues').textContent === '10000', 'Large import incomplete');
  assert(doc.querySelectorAll('.cue-row').length < 100, 'List did not virtualize');
  el('cueList').scrollTop = el('cueList').scrollHeight; el('cueList').dispatchEvent(new win.Event('scroll')); await delay(200);
  assert([...doc.querySelectorAll('.cue-row')].some(row => row.textContent.includes('Dialogue 10000')), 'Last virtual row missing');
  input('search', 'Dialogue 9987'); await delay(80);
  assert(doc.querySelectorAll('.cue-row').length === 1, 'Search failed on virtual list');
  doc.querySelector('.cue-row').click(); assert(el('activeNumber').textContent === '#9987', 'Filtered row selected wrong cue');
  results.push('10,000 cues remain virtualized, searchable, and selectable');

  // Concurrent instances must reject stale writes rather than overwrite the latest revision.
  const first = await new ProjectStore().open(), second = await new ProjectStore().open();
  const project = createProject('Browser conflict check');
  await first.save(project); await second.list();
  const newer = { ...project, revision: 1, updatedAt: project.updatedAt + 1, title: 'Latest writer' };
  await first.save(newer);
  let conflict = false;
  try { await second.save({ ...project, revision: 1, updatedAt: project.updatedAt + 2, title: 'Stale writer' }); } catch (error) { conflict = error instanceof ConflictError; }
  assert(conflict, 'Concurrent stale write was accepted');
  const tx = first.db.transaction('projects', 'readwrite'); tx.objectStore('projects').delete(project.id);
  for (const item of first.journals()) if (item.project.id === project.id) localStorage.removeItem(item.key);
  first.db.close(); second.db.close();
  results.push('Concurrent stale saves are rejected');

  await load('/downloads/Cutline.html');
  assert(!doc.querySelector('script[src],link[rel=stylesheet]'), 'Standalone has runtime file dependencies');
  assert(el('statusCues').textContent === '10000', 'Standalone did not start or recover data');
  input('search', 'Dialogue 9987'); doc.querySelector('.cue-row').click();
  input('textField', 'Standalone editing works'); click('reviewBtn'); await saved();
  assert(el('textField').value === 'Standalone editing works', 'Standalone interaction failed');
  results.push('Self-contained HTML starts and edits without external scripts or styles');
  return results;
}
