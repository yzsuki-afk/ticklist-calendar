// Explicit opt-in integration test. Creates ONE uniquely marked task/event and
// removes it in finally. Never touches any pre-existing task/calendar event.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import os from 'node:os'
import { createBridge } from '../sync/bridge.js'
import { localDateTimeToISO } from '../sync/planner.js'
if (process.env.TICKLIST_LIVE_SMOKE !== '1') throw new Error('Requires explicit TICKLIST_LIVE_SMOKE=1; this test modifies the dedicated calendar temporarily.')
const base = process.env.TICKLIST_TEST_ORIGIN
if (!base || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error('TICKLIST_TEST_ORIGIN must be an explicit local DSH URL')
const prefix = base + '/ticklist-calendar/'
const dataDir = join(os.homedir(), '.dsh', 'storages', 'ticklist-calendar')
const bridge = createBridge(process.cwd(), dataDir)
const id = 'apple-smoke-' + randomUUID()
let created = false, eventID, calendarID
const checks = []
async function api(path, data, method = 'POST') {
  const response = await fetch(prefix + path, data === undefined ? {} : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`)
  return result
}
async function state() { return api('api/state') }
async function update(fn) {
  const before = await state(); const tasks = fn(structuredClone(before.tasks))
  return api('api/state', { ...before, tasks }, 'PUT')
}
async function sync() {
  for (let i = 0; i < 60; i++) {
    const result = await api('api/apple/sync', {})
    if (!result.busy) { if (result.skipped) throw new Error('Sync disabled'); return result }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error('Sync busy timeout')
}
const expected = e => ({ title:e.title,notes:e.notes||null,start:e.start,end:e.end,allDay:e.allDay,timeZone:e.timeZone||null,...(e.lastModified?{lastModified:e.lastModified}:{}) })
async function event() {
  const now = new Date(), end = new Date(now); now.setMonth(now.getMonth() - 1); end.setMonth(end.getMonth() + 2)
  const snapshot = await bridge.request('snapshot', { calendarID, start:now.toISOString(),end:end.toISOString(),trackedEventIDs:eventID?[eventID]:[] })
  return snapshot.events.find(e => e.taskId === id)
}
try {
  const status = await api('api/apple/status')
  assert.ok(status.enabled && status.authorized && status.calendarID, 'Must first enable authorized dedicated calendar sync')
  calendarID = status.calendarID
  const initial = await state()
  const date = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(Date.now() + 86400000))
  await update(tasks => [...tasks, { id, title:'[自动清理] 日历同步验收', notes:'电脑创建', date, start:null,end:null,list:initial.lists[0]?.id||'inbox',group:initial.groups.find(g=>!g.done)?.id||'g-todo',done:false }]); created=true
  await sync()
  let remote = await event(); assert.ok(remote); eventID=remote.id
  assert.equal(remote.notes,'电脑创建'); assert.equal(remote.allDay,true)
  assert.equal(remote.start,localDateTimeToISO(date,'00:00','Asia/Shanghai')); checks.push('desktop-create-all-day')
  await bridge.request('apply',{calendarID,operations:[{op:'update',id:eventID,taskId:id,title:remote.title,notes:'Apple 日历侧修改',start:localDateTimeToISO(date,'12:00','Asia/Shanghai'),end:localDateTimeToISO(date,'13:00','Asia/Shanghai'),allDay:false,timeZone:'Asia/Shanghai',expected:expected(remote)}]})
  await sync()
  const local=(await state()).tasks.find(t=>t.id===id)
  assert.equal(local.notes,'Apple 日历侧修改'); assert.equal(local.start,'12:00'); checks.push('apple-edit-import')
  await update(tasks=>tasks.map(t=>t.id===id?{...t,title:'[自动清理] 电脑再次修改'}:t)); await sync()
  remote=await event(); assert.equal(remote.title,'[自动清理] 电脑再次修改'); checks.push('desktop-edit-export')
  await update(tasks=>tasks.map(t=>t.id===id?{...t,start:null,end:null}:t)); await sync()
  remote=await event(); assert.equal(remote.allDay,true); checks.push('timed-to-all-day')
  await update(tasks=>tasks.map(t=>t.id===id?{...t,title:'[自动清理] 全天修改验收'}:t)); await sync()
  remote=await event(); assert.equal(remote.title,'[自动清理] 全天修改验收'); assert.equal(remote.allDay,true); checks.push('all-day-edit-preserved')
} finally {
  if (created) {
    // First converge any in-flight remote edit so delete preconditions remain safe.
    await sync()
    await update(tasks=>tasks.filter(t=>t.id!==id)); await sync()
    assert.equal((await state()).tasks.some(t=>t.id===id),false)
    assert.equal(await event(),undefined)
    checks.push('cleanup-delete-verified')
  }
  console.log(JSON.stringify({checks,temporaryTask:id,cleaned:created&&checks.includes('cleanup-delete-verified')}))
}
