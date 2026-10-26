import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
const html = readFileSync(new URL('../app/index.html', import.meta.url), 'utf8')
function section(a, b) { const start = html.indexOf(a); assert.ok(start >= 0); const end = html.indexOf(b, start); assert.ok(end > start); return html.slice(start, end) }
function context(overrides = {}) {
  const ctx = { tasks: [{ id: 'local', title: '保留' }], LISTS: [], groups: [], seq: 1000, API: 'api/state', editGeneration: 0, dirty: false, saving: false, detailTask: null, serverBase: null, serverRevision: 'before', normalizeGroups: x => x, normalizeTaskGroups() {}, saveNotice() {}, ...overrides }
  vm.createContext(ctx); return ctx
}
test('failed refresh never clears existing tasks or baseline', async () => {
  const ctx = context({ fetch: () => Promise.reject(new Error('offline')) })
  vm.runInContext(section('  function loadState()', '  var serverRevision'), ctx)
  await ctx.loadState()
  assert.equal(ctx.tasks[0].id, 'local'); assert.equal(ctx.serverRevision, 'before')
})
test('refresh response arriving after a local edit is not adopted', async () => {
  let respond
  const ctx = context({ fetch: () => new Promise(resolve => { respond = resolve }) })
  vm.runInContext(section('  function loadState()', '  var serverRevision'), ctx)
  const pending = ctx.loadState()
  ctx.editGeneration++
  respond({ ok: true, json: async () => ({ tasks: [], lists: [], groups: [], revision: 'new' }) })
  await pending
  assert.equal(ctx.tasks[0].id, 'local'); assert.equal(ctx.serverRevision, 'before')
})
test('server-deleted calendar fields are removed rather than resurrected', () => {
  const prior = { id: 'a', title: '会议', appleCalendarEndDate: '2026-10-27' }
  const ctx = context({ tasks: [structuredClone(prior)] })
  vm.runInContext(section('  function adoptSaved(', '  function flushSave('), ctx)
  ctx.adoptSaved({ tasks: [{ id: 'a', title: '会议' }], lists: [], groups: [] }, { tasks: [prior], lists: [], groups: [] })
  assert.equal('appleCalendarEndDate' in ctx.tasks[0], false)
})
test('new browser tasks use independent UUIDs, not per-tab counters', () => {
  assert.ok(section('  function makeTask(', '  var key =').includes('crypto.randomUUID()'))
})
