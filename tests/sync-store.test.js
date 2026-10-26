import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore, mergeState, StateConflict } from '../sync/store.js'

const base = { tasks: [{ id: 'a', title: '旧标题', notes: '旧备注', done: false }], lists: [], groups: [] }
test('merge unrelated phone and desktop fields without overwriting either', () => {
  const merged = mergeState(base, { ...base, tasks: [{ ...base.tasks[0], done: true }] }, { ...base, tasks: [{ ...base.tasks[0], title: '手机标题' }] })
  assert.equal(merged.tasks[0].title, '手机标题')
  assert.equal(merged.tasks[0].done, true)
})
test('preserve phone-created tasks absent in stale tab', () => {
  const merged = mergeState(base, base, { ...base, tasks: [...base.tasks, { id: 'phone' }] })
  assert.equal(merged.tasks.length, 2)
})
test('reject conflicting updates and delete/edit races', () => {
  assert.throws(() => mergeState(base, { ...base, tasks: [] }, { ...base, tasks: [{ ...base.tasks[0], title: 'changed' }] }), StateConflict)
  assert.throws(() => mergeState(base, { ...base, tasks: [{ id: 'a', title: 'mine' }] }, { ...base, tasks: [{ id: 'a', title: 'theirs' }] }), StateConflict)
})
test('revision lock rejects old clients; atomic saves retain metadata', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ticklist-store-'))
  try {
    const store = createStore(dir)
    await store.write({ ...base, appleMetadata: { intact: true } })
    const before = await store.read()
    await assert.rejects(store.saveClient({ tasks: [] }), StateConflict)
    await store.saveClient({ ...before, tasks: [], revision: store.publicState(before).revision })
    assert.deepEqual((await store.read()).appleMetadata, { intact: true })
    await writeFile(store.file, '{bad')
    await assert.rejects(store.read())
  } finally { await rm(dir, { recursive: true, force: true }) }
})
