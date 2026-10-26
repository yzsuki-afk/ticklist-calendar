import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createStore } from '../sync/store.js'
import { createSyncController, nativeOperation } from '../sync/controller.js'

async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'ticklist-sync-test-'))
  const store = createStore(dir)
  await store.write({ tasks: [], lists: [{ id: 'inbox' }], groups: [{ id: 'todo', done: false }] })
  let events = [], writes = 0, seq = 0, authorized = true, failSnapshot = false
  const bridge = { async request(command, args = {}) {
    if (command === 'status') return { ok: true, authorized, sources: [{ id: 'icloud' }] }
    if (command === 'initialize') return { ok: true, calendar: { id: 'managed', sourceId: 'icloud' } }
    if (command === 'snapshot') {
      if (failSnapshot) throw new Error('EventKit unavailable')
      return { ok: true, events: structuredClone(events), missingTrackedEventIDs: (args.trackedEventIDs || []).filter(id => !events.some(e => e.id === id)), outOfCalendarTrackedEventIDs: [] }
    }
    if (command === 'apply') {
      writes++
      assert.ok(args.operations.length <= 500)
      for (const op of args.operations) {
        if (op.op === 'update' || op.op === 'delete') assert.ok(op.expected, 'mutations require native precondition')
      }
      const results = []
      for (const op of args.operations) {
        if (op.op === 'create') {
          const event = { ...op, id: 'event-' + ++seq, recurring: false }; delete event.op
          events.push(event); results.push({ op: 'create', taskId: op.taskId, event: structuredClone(event) })
        } else {
          const event = events.find(x => x.id === op.id)
          if (op.op === 'delete') events = events.filter(x => x.id !== op.id)
          else if (op.op === 'link') { assert.equal(event.taskId, null); event.taskId = op.taskId }
          else { assert.equal(event.taskId, op.taskId); Object.assign(event, op) }
          results.push({ op: op.op, taskId: op.taskId, event: event && structuredClone(event) })
        }
      }
      return { ok: true, results }
    }
    throw new Error('unknown command')
  } }
  const sync = createSyncController({ store, bridge, intervalMs: 3600000 })
  try { await fn({ store, sync, get events() { return events }, get writes() { return writes }, deny() { authorized = false }, fail() { failSnapshot = true }, phone(event) { events.push(event) } }) }
  finally { sync.stop(); await rm(dir, { recursive: true, force: true }) }
}
const nextDate = () => { const d = new Date(); d.setDate(d.getDate() + 3); return d.toISOString().slice(0, 10) }

test('create, acknowledge, idempotent retry and edits each direction', async () => fixture(async f => {
  await f.store.write({ ...(await f.store.read()), tasks: [{ id: 't1', title: '会议', date: nextDate(), start: '10:00', end: '11:00', notes: '', done: false, group: 'todo', list: 'inbox' }] })
  await f.sync.configure({ enabled: true, sourceID: 'icloud' })
  assert.equal(f.events.length, 1)
  await f.sync.run(); assert.equal(f.writes, 1)
  f.events[0].notes = '手机备注'
  await f.sync.run(); assert.equal((await f.store.read()).tasks[0].notes, '手机备注')
  const state = await f.store.read(); state.tasks[0].title = '电脑改标题'; await f.store.write(state)
  await f.sync.run(); assert.equal(f.events[0].title, '电脑改标题')
  await f.sync.run(); assert.equal(f.events.length, 1)
}))
test('phone event imported, linked, then plugin edit succeeds', async () => fixture(async f => {
  f.phone({ id: 'phone', taskId: null, title: '手机创建', notes: '', start: nextDate() + 'T03:00:00Z', end: nextDate() + 'T04:00:00Z', allDay: false, timeZone: 'Asia/Shanghai', recurring: false })
  await f.sync.configure({ enabled: true, sourceID: 'icloud' })
  const state = await f.store.read(); assert.equal(state.tasks.length, 1)
  assert.equal(f.events[0].taskId, state.tasks[0].id)
  state.tasks[0].notes = '电脑补充'; await f.store.write(state); await f.sync.run()
  assert.equal(f.events[0].notes, '电脑补充')
}))
test('all-day native operation is local midnight not UTC midnight', () => {
  const op = nativeOperation({ op: 'create', allDay: true, start: '2026-10-25', end: '2026-10-26', timeZone: 'Asia/Shanghai' })
  assert.equal(op.start, '2026-10-24T16:00:00.000Z')
  assert.equal(op.end, '2026-10-25T16:00:00.000Z')
})
test('denied permission and failed snapshot never wipe tasks', async () => fixture(async f => {
  f.deny()
  await assert.rejects(f.sync.configure({ enabled: true, sourceID: 'icloud' }))
  assert.equal(f.writes, 0)
}))
test('remote deletion retains task and does not recreate event', async () => fixture(async f => {
  await f.store.write({ ...(await f.store.read()), tasks: [{ id: 't1', title: '会议', date: nextDate(), start: null, notes: '' }] })
  await f.sync.configure({ enabled: true, sourceID: 'icloud' })
  f.events.splice(0)
  await f.sync.run()
  const state = await f.store.read(); assert.equal(state.tasks.length, 1)
  assert.equal(state.tasks[0].appleCalendarSyncConflict, 'remote-deleted')
  assert.equal(f.events.length, 0)
}))
test('user URLs skipped without blocking other tasks', async () => fixture(async f => {
  f.phone({ id: 'url-event', taskId: null, linkable: false, title: '保留网址', notes: '', start: nextDate() + 'T03:00:00Z', end: nextDate() + 'T04:00:00Z', allDay: false, timeZone: 'Asia/Shanghai', recurring: false })
  await f.store.write({ ...(await f.store.read()), tasks: [{ id: 't1', title: '正常', date: nextDate(), start: null }] })
  await f.sync.configure({ enabled: true, sourceID: 'icloud' })
  assert.equal(f.events.length, 2)
  assert.equal(f.events[0].taskId, null)
  assert.equal((await f.sync.status()).warnings[0].code, 'user-url-preserved')
}))
test('501 task writes split into bounded batches and stay idempotent', async () => fixture(async f => {
  const tasks = Array.from({ length: 501 }, (_, i) => ({ id: 'bulk-' + i, title: '测试' + i, date: nextDate(), start: null }))
  await f.store.write({ ...(await f.store.read()), tasks })
  await f.sync.configure({ enabled: true, sourceID: 'icloud' })
  assert.equal(f.events.length, 501)
  assert.equal(f.writes, 2)
  await f.sync.run(); assert.equal(f.writes, 2)
}))
test('snapshot failure preserves every local task', async () => fixture(async f => {
  await f.store.write({ ...(await f.store.read()), tasks: [{ id: 't1', title: '保留', date: nextDate(), start: null }] })
  await f.sync.configure({ enabled: true, sourceID: 'icloud' })
  f.fail()
  await assert.rejects(f.sync.run(), /unavailable/)
  assert.equal((await f.store.read()).tasks[0].title, '保留')
}))
