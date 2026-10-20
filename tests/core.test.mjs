import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTime, time, parseSrt, serializeSrt, createProject, validateProject, analyzeCues, activeCueAt, shiftCues, fixOverlap, cleanText, History } from '../src/core.js';

const cue = (id, start, end, text = 'Hello', extra = {}) => ({ id, start, end, text, reviewed: false, reference: '', ...extra });

test('timestamps reject out-of-range fields and retain exact millisecond precision', () => {
  assert.ok(Number.isNaN(parseTime('00:60:01.000')));
  assert.ok(Number.isNaN(parseTime('00:00:61.000')));
  assert.ok(Number.isNaN(parseTime('-01:00:00.000')));
  for (const milliseconds of [0, 1, 999, 1000, 3599999, 3600000, 360000000]) assert.equal(parseTime(time(milliseconds)), milliseconds);
  assert.equal(parseTime('01:02:03,04'), 3723040);
});
test('SRT round trips Bengali, multiline text, BOM, CRLF, and nonconsecutive numbering', () => {
  const input = '\uFEFF9\r\n00:00:01,234 --> 00:00:04,567\r\nবাংলা সংলাপ\r\nSecond line\r\n\r\n42\r\n00:00:05,000 --> 00:00:07,000\r\nA & B <i>text</i>\r\n';
  const report = parseSrt(input); assert.equal(report.errors.length, 0); assert.equal(report.cues.length, 2);
  const again = parseSrt(serializeSrt(report.cues));
  assert.deepEqual(again.cues.map(({ start, end, text }) => ({ start, end, text })), report.cues.map(({ start, end, text }) => ({ start, end, text })));
});
test('malformed and backwards SRT blocks are explicitly reported without losing valid blocks', () => {
  const report = parseSrt('1\n00:00:01,000 --> 00:00:03,000\nGood\n\n2\n00:70:00,000 --> 00:71:00,000\nBad\n\n3\n00:00:05,000 --> 00:00:04,000\nBackwards\n\nno timings');
  assert.equal(report.cues.length, 1); assert.equal(report.errors.length, 3); assert.equal(report.errors[0].block, 2);
  assert.throws(() => serializeSrt([cue('x', 2000, 1000)]));
});
test('unsorted input and overlaps do not break active-cue lookup', () => {
  const cues = [cue('late', 5000, 8000), cue('early', 0, 2000), cue('overlap', 1000, 3000)];
  assert.equal(activeCueAt(cues, 500)?.id, 'early'); assert.equal(activeCueAt(cues, 1500)?.id, 'overlap');
  assert.equal(activeCueAt(cues, 8000), null);
  assert.ok(analyzeCues(cues).get('early').includes('Overlaps another cue'));
  assert.ok(!analyzeCues([cue('a', 0, 1000), cue('b', 1000, 2000)]).get('b').includes('Overlaps another cue'));
});
test('bulk shift clamps the whole group together and keeps durations and spacing', () => {
  const before = [cue('a', 100, 1100), cue('b', 500, 1500)];
  const shifted = shiftCues(before, new Set(['a', 'b']), -400);
  assert.equal(shifted.applied, -100); assert.equal(shifted.cues[0].start, 0); assert.equal(shifted.cues[1].start, 400);
  assert.equal(shifted.cues[1].end - shifted.cues[1].start, 1000); assert.equal(before[0].start, 100);
});
test('overlap correction cannot create an invalid or near-zero cue', () => {
  assert.throws(() => fixOverlap([cue('a', 0, 3000), cue('b', 2000, 2500)], 'b'));
  const fixed = fixOverlap([cue('a', 0, 2100), cue('b', 2000, 4000)], 'b');
  assert.equal(fixed[1].start, 2120); assert.equal(fixed[1].end, 4000);
});
test('project backups preserve review and reference by stable ID across insertions and deletions', () => {
  const original = cue('kept', 2000, 4000, 'বাংলা', { reviewed: true, reference: 'Reference' });
  const project = createProject('Test', [cue('inserted', 0, 1000), original]);
  project.cues = project.cues.filter(item => item.id !== 'inserted');
  const roundTrip = validateProject(JSON.parse(JSON.stringify(project)));
  assert.equal(roundTrip.cues[0].id, 'kept'); assert.equal(roundTrip.cues[0].reviewed, true); assert.equal(roundTrip.cues[0].reference, 'Reference');
  assert.equal(validateProject(createProject('Empty')).cues.length, 0);
  assert.throws(() => validateProject({ ...project, version: 999 }));
  assert.throws(() => validateProject({ ...project, cues: [original, original] }));
});
test('undo and redo preserve Unicode text, review state, and selection', () => {
  const history = new History(); const initial = { cues: [cue('a', 0, 1000, 'বাংলা')], selection: ['a'] };
  history.push(initial, 'Edit'); const edited = structuredClone(initial); edited.cues[0].text = 'Edited'; edited.cues[0].reviewed = true;
  assert.deepEqual(history.move('undo', edited), initial); assert.deepEqual(history.move('redo', initial), edited);
  history.push(edited, 'Next'); assert.equal(history.redo.length, 0);
});
test('punctuation cleanup does not rewrite words or remove line breaks', () => {
  assert.equal(cleanText('May be this is correct .\n Any thing  else... '), 'May be this is correct.\nAny thing else…');
});
test('10,000-cue parsing and quality analysis retain every cue and unique ID', () => {
  const input = Array.from({ length: 10000 }, (_, index) => `${index + 1}\n${time(index * 3000, true)} --> ${time(index * 3000 + 2000, true)}\nSubtitle ${index + 1}`).join('\n\n');
  const report = parseSrt(input); assert.equal(report.cues.length, 10000); assert.equal(new Set(report.cues.map(item => item.id)).size, 10000);
  assert.equal(analyzeCues(report.cues).size, 10000);
});
