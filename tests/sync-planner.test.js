import test from 'node:test';
import assert from 'node:assert/strict';
import { planSync, importedTaskId, localDateTimeToISO } from '../sync/planner.js';

const config = { calendarID: 'managed', timeZone: 'Asia/Shanghai', windowStart: '2026-01-01', windowEnd: '2027-01-01' };
const task = { id: 't1', title: 'Meeting', date: '2026-10-24', start: '09:00', end: '10:00', notes: 'Notes', list: 'work', group: 'team', done: false, custom: { untouched: true } };
const event = { id: 'e1', externalId: 'external-1', taskId: 't1', title: 'Meeting', notes: 'Notes', start: '2026-10-24T09:00:00+08:00', end: '2026-10-24T10:00:00+08:00', allDay: false, timeZone: 'Asia/Shanghai', lastModified: '2020-01-01T00:00:00Z', recurring: false };
const run = input => planSync({ ...config, ...input });
const baseline = () => run({ tasks: [task], events: [event] }).newLinks;
function deepFreeze(value) {
  if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(deepFreeze); }
  return value;
}

test('pure deterministic create, confirmation and idempotent round trip', () => {
  const input = deepFreeze({ tasks: [structuredClone(task)], events: [], ...config });
  const first = planSync(input);
  assert.deepEqual(planSync(input), first);
  assert.equal(first.operations[0].op, 'create');
  assert.equal(first.operations[0].start, '2026-10-24T01:00:00.000Z');
  assert.equal(first.newLinks.entries.t1.baseline, null);
  const confirmed = run({ tasks: first.newTasks, links: first.newLinks, events: [event] });
  assert.deepEqual(confirmed.operations, []);
  assert.ok(confirmed.newLinks.entries.t1.baseline);
  const repeat = run({ tasks: confirmed.newTasks, links: confirmed.newLinks, events: [event] });
  assert.deepEqual(repeat, confirmed);
});

test('retry after successful create adopts marker with missing links and never duplicates', () => {
  const first = run({ tasks: [task], events: [] });
  const retry = run({ tasks: [task], events: [event], links: first.newLinks });
  assert.equal(retry.newLinks.entries.t1.eventId, 'e1');
  assert.deepEqual(retry.operations, []);
  assert.deepEqual(run({ tasks: [task], events: [event] }).operations, []);
});

test('unconfirmed writes retain baseline and retry same update', () => {
  const links = baseline();
  const local = { ...task, title: 'Local' };
  const first = run({ tasks: [local], events: [event], links });
  assert.equal(first.operations[0].title, 'Local');
  assert.deepEqual(first.newLinks, links);
  assert.deepEqual(run({ tasks: first.newTasks, events: [event], links: first.newLinks }).operations, first.operations);
  const ack = run({ tasks: first.newTasks, events: [{ ...event, title: 'Local' }], links: first.newLinks });
  assert.deepEqual(ack.operations, []);
  assert.equal(ack.newLinks.entries.t1.baseline.event.title, 'Local');
});

test('remote edit imports without touching unsynced fields and ignores timestamps', () => {
  const result = run({ tasks: [{ ...task, done: true }], events: [{ ...event, title: 'Remote', lastModified: '1900-01-01T00:00:00Z' }], links: baseline() });
  assert.equal(result.newTasks[0].title, 'Remote');
  assert.equal(result.newTasks[0].done, true);
  assert.equal(result.newTasks[0].list, 'work');
  assert.deepEqual(result.newTasks[0].custom, task.custom);
  assert.deepEqual(result.operations, []);
});

test('disjoint field changes merge, survive retry, then converge', () => {
  const changedEvent = { ...event, notes: 'Remote notes' };
  const first = run({ tasks: [{ ...task, title: 'Local title' }], events: [changedEvent], links: baseline() });
  assert.equal(first.newTasks[0].notes, 'Remote notes');
  assert.equal(first.operations[0].title, 'Local title');
  assert.equal(first.operations[0].notes, 'Remote notes');
  assert.deepEqual(first.conflicts, []);
  const retry = run({ tasks: first.newTasks, events: [changedEvent], links: first.newLinks });
  assert.deepEqual(retry.operations, first.operations);
  const ack = run({ tasks: retry.newTasks, events: [{ ...changedEvent, title: 'Local title' }], links: retry.newLinks });
  assert.deepEqual(ack.operations, []);
  assert.deepEqual(ack.conflicts, []);
});

test('same-field conflict freezes pair and retains both sides and baseline', () => {
  const local = { ...task, title: 'Local', notes: 'Also local' };
  const remote = { ...event, title: 'Remote' };
  const links = baseline();
  const result = run({ tasks: [local], events: [remote], links });
  assert.deepEqual(result.operations, []);
  assert.deepEqual(result.newTasks, [local]);
  assert.deepEqual(result.newLinks, links);
  assert.deepEqual(result.conflicts[0].fields, ['title']);
  assert.equal(result.conflicts[0].local.title, 'Local');
  assert.equal(result.conflicts[0].remote.title, 'Remote');
});

test('equal concurrent edits converge without conflict', () => {
  const result = run({ tasks: [{ ...task, title: 'Same' }], events: [{ ...event, title: 'Same' }], links: baseline() });
  assert.deepEqual(result.operations, []);
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.newLinks.entries.t1.baseline.task.title, 'Same');
});

test('tracked local removal proposes delete and confirms only explicit missing ID', () => {
  const links = baseline();
  const result = run({ tasks: [], events: [event], links });
  assert.deepEqual(result.operations, [{ op: 'delete', id: 'e1', taskId: 't1' }]);
  const omitted = run({ tasks: [], events: [], links });
  assert.ok(omitted.newLinks.entries.t1);
  const confirmed = run({ tasks: [], events: [], links, missingEventIds: ['e1'] });
  assert.deepEqual(confirmed.newLinks.entries, {});
});

test('remote omission is not deletion; explicit deletion retains task in conflict', () => {
  const links = baseline();
  const omitted = run({ tasks: [task], events: [], links });
  assert.deepEqual(omitted.newTasks, [task]);
  assert.deepEqual(omitted.operations, []);
  assert.deepEqual(omitted.conflicts, []);
  const deleted = run({ tasks: [task], events: [], links, missingEventIds: ['e1'] });
  assert.equal(deleted.conflicts[0].type, 'remote-deleted');
  assert.equal(deleted.newTasks[0].appleCalendarSyncConflict, 'remote-deleted');
  assert.equal(deleted.newTasks[0].title, task.title);
  assert.deepEqual(deleted.operations, []);
});

test('undating a linked task conflicts unless explicit delete policy', () => {
  const input = { tasks: [{ ...task, date: null }], events: [event], links: baseline() };
  assert.equal(run(input).conflicts[0].type, 'missing-date');
  assert.deepEqual(run(input).operations, []);
  assert.equal(run({ ...input, undatedPolicy: 'delete' }).operations[0].op, 'delete');
});

test('only in-window unrelated dedicated-calendar events import with stable IDs', () => {
  const input = { tasks: [], events: [
    { ...event, id: 'e1', taskId: null },
    { ...event, id: 'old', taskId: null, start: '2020-01-01T00:00:00Z', end: '2020-01-01T01:00:00Z' },
    { ...event, id: 'foreign', taskId: null, calendarID: 'other' },
    { ...event, id: 'orphan', taskId: 'removed-task' },
  ] };
  const first = run(input);
  assert.equal(first.newTasks.length, 1);
  assert.equal(first.newTasks[0].id, importedTaskId('managed', 'e1'));
  const repeat = run({ tasks: first.newTasks, events: input.events, links: first.newLinks });
  assert.deepEqual(repeat.newTasks, first.newTasks);
  assert.deepEqual(repeat.operations, []);
});

test('all-day exclusive multi-day end is preserved across import and local edits', () => {
  const remote = { ...event, taskId: null, allDay: true, start: '2026-10-24T00:00:00+08:00', end: '2026-10-27T00:00:00+08:00' };
  const first = run({ events: [remote] });
  assert.equal(first.newTasks[0].date, '2026-10-24');
  assert.equal(first.newTasks[0].appleCalendarEndDate, '2026-10-27');
  assert.equal(first.newTasks[0].start, null);
  const second = run({ tasks: [{ ...first.newTasks[0], title: 'Changed' }], events: [remote], links: first.newLinks });
  assert.equal(second.operations[0].start, '2026-10-24');
  assert.equal(second.operations[0].end, '2026-10-27');
  assert.equal(second.operations[0].allDay, true);
});

test('recurring events never import, update or delete', () => {
  const recurring = { ...event, recurring: true };
  for (const input of [
    { tasks: [task], events: [recurring], links: baseline() },
    { tasks: [], events: [recurring], links: baseline() },
    { tasks: [], events: [{ ...recurring, taskId: null }] },
  ]) {
    const result = run(input);
    assert.deepEqual(result.operations, []);
    assert.equal(result.warnings[0].type, 'unsupported-recurring');
    assert.equal(result.newTasks.length, input.tasks.length);
  }
});

test('DST conversion rejects gaps/folds and supports half-hour and quarter-hour zones', () => {
  assert.throws(() => localDateTimeToISO('2026-03-08', '02:30', 'America/New_York'), /nonexistent/);
  assert.throws(() => localDateTimeToISO('2026-11-01', '01:30', 'America/New_York'), /ambiguous/);
  assert.equal(localDateTimeToISO('2026-03-08', '03:30', 'America/New_York'), '2026-03-08T07:30:00.000Z');
  assert.equal(localDateTimeToISO('2026-10-24', '09:00', 'Asia/Kathmandu'), '2026-10-24T03:15:00.000Z');
  assert.throws(() => localDateTimeToISO('2026-04-05', '01:45', 'Australia/Lord_Howe'), /ambiguous/);
  assert.throws(() => localDateTimeToISO('2026-10-04', '02:15', 'Australia/Lord_Howe'), /nonexistent/);
});

test('local DST failures do not produce writes', () => {
  for (const [date, start] of [['2026-03-08', '02:30'], ['2026-11-01', '01:30']]) {
    const result = run({ tasks: [{ ...task, date, start, end: '04:00' }], timeZone: 'America/New_York' });
    assert.deepEqual(result.operations, []);
    assert.equal(result.warnings[0].type, 'invalid-local-task');
  }
});

test('imported DST fold and seconds retain exact instants on roundtrip', () => {
  const remote = { ...event, taskId: null, timeZone: 'America/New_York', start: '2026-11-01T01:30:15-04:00', end: '2026-11-01T01:30:15-05:00' };
  const first = run({ events: [remote] });
  assert.equal(first.newTasks[0].start, '01:30');
  const repeat = run({ tasks: first.newTasks, events: [remote], links: first.newLinks });
  assert.deepEqual(repeat.operations, []);
  assert.deepEqual(repeat.conflicts, []);
  assert.deepEqual(repeat.warnings, []);
});

test('remote schedule edit preserves unrelated metadata and overnight date', () => {
  const remote = { ...event, start: '2026-10-24T23:00:00+08:00', end: '2026-10-25T01:00:00+08:00' };
  const result = run({ tasks: [task], events: [remote], links: baseline() });
  assert.equal(result.newTasks[0].start, '23:00');
  assert.equal(result.newTasks[0].end, '01:00');
  assert.equal(result.newTasks[0].appleCalendarEndDate, '2026-10-25');
  assert.deepEqual(result.newTasks[0].custom, task.custom);
  assert.deepEqual(run({ tasks: result.newTasks, events: [remote], links: result.newLinks }).operations, []);
});

test('duplicate markers, mismatches and unbased divergence never write', () => {
  const dup = run({ tasks: [task], events: [event, { ...event, id: 'e2' }], links: baseline() });
  assert.equal(dup.conflicts[0].type, 'duplicate-task-marker');
  assert.deepEqual(dup.operations, []);
  const mismatch = run({ tasks: [], events: [{ ...event, taskId: 'different' }], links: baseline() });
  assert.equal(mismatch.conflicts[0].type, 'event-marker-mismatch');
  assert.deepEqual(mismatch.operations, []);
  const divergent = run({ tasks: [task], events: [{ ...event, title: 'Diverged' }] });
  assert.equal(divergent.conflicts[0].type, 'unbased-divergence');
  assert.deepEqual(divergent.operations, []);
});

test('all-day UTC instants use the event zone, not their ISO prefix', () => {
  const remote = { ...event, taskId: null, allDay: true, start: '2026-10-23T16:00:00Z', end: '2026-10-26T16:00:00Z' };
  const result = run({ events: [remote] });
  assert.equal(result.newTasks[0].date, '2026-10-24');
  assert.equal(result.newTasks[0].appleCalendarEndDate, '2026-10-27');
  assert.deepEqual(run({ tasks: result.newTasks, events: [remote], links: result.newLinks }).operations, []);
});

test('a second remote edit does not conflict with previously merged disjoint field', () => {
  const first = run({ tasks: [{ ...task, title: 'Pending local title' }], events: [{ ...event, notes: 'First remote notes' }], links: baseline() });
  const second = run({ tasks: first.newTasks, events: [{ ...event, notes: 'Second remote notes' }], links: first.newLinks });
  assert.deepEqual(second.conflicts, []);
  assert.equal(second.newTasks[0].notes, 'Second remote notes');
  assert.equal(second.operations[0].notes, 'Second remote notes');
  assert.equal(second.operations[0].title, 'Pending local title');
});

test('local deletion and undating never discard concurrently edited remote data', () => {
  const remote = { ...event, notes: 'Unsynced remote notes' };
  const deleted = run({ tasks: [], events: [remote], links: baseline() });
  assert.deepEqual(deleted.operations, []);
  assert.equal(deleted.conflicts[0].type, 'local-deleted-remote-modified');
  const undated = run({ tasks: [{ ...task, date: null }], events: [remote], links: baseline(), undatedPolicy: 'delete' });
  assert.deepEqual(undated.operations, []);
  assert.equal(undated.conflicts[0].type, 'undated-remote-modified');
});

test('reappearing remote event clears owned deletion conflict marker', () => {
  const links = baseline();
  const deleted = run({ tasks: [task], links, missingEventIds: ['e1'] });
  const restored = run({ tasks: deleted.newTasks, events: [event], links: deleted.newLinks });
  assert.equal(restored.newTasks[0].appleCalendarSyncConflict, undefined);
  assert.deepEqual(restored.conflicts, []);
});

test('all-day windows use actual civil-day instants and exclusive end', () => {
  const remote = { ...event, taskId: null, allDay: true, start: '2026-10-24', end: '2026-10-25' };
  const after = run({ events: [remote], windowStart: '2026-10-24T16:00:00Z' });
  assert.deepEqual(after.newTasks, []);
  const before = run({ events: [remote], windowEnd: '2026-10-23T16:00:00Z' });
  assert.deepEqual(before.newTasks, []);
  const overlap = run({ events: [remote], windowStart: '2026-10-24', windowEnd: '2026-10-25' });
  assert.equal(overlap.newTasks.length, 1);
});

test('all-day DST transition days use 23/25 hour civil boundaries', () => {
  const spring = { ...event, taskId: null, allDay: true, timeZone: 'America/New_York', start: '2026-03-08', end: '2026-03-09' };
  const included = run({ events: [spring], windowStart: '2026-03-09T03:59:00Z', windowEnd: '2026-03-09T05:00:00Z' });
  assert.equal(included.newTasks.length, 1);
  const excluded = run({ events: [spring], windowStart: '2026-03-09T04:00:00Z', windowEnd: '2026-03-09T05:00:00Z' });
  assert.deepEqual(excluded.newTasks, []);
});

test('validates link calendar/version and malformed inputs without process timezone guessing', () => {
  assert.throws(() => run({ windowStart: '2026-10-24T00:00:00' }), /invalid-sync-window/);
  assert.throws(() => run({ links: { version: 2, calendarID: 'managed', entries: {} } }), /incompatible-links/);
  assert.throws(() => run({ links: { version: 1, calendarID: 'other', entries: {} } }), /incompatible-links/);
  assert.throws(() => run({ windowStart: 'garbage' }), /invalid-sync-window/);
  const malformed = run({ events: [{ ...event, taskId: null, start: '2026-10-24T09:00:00' }] });
  assert.equal(malformed.warnings[0].type, 'invalid-remote-event');
  assert.deepEqual(malformed.newTasks, []);
});
