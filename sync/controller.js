import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { planSync, localDateTimeToISO } from './planner.js'

export function nativeOperation(op) {
  if (!op.allDay || op.op === 'delete') return op
  return { ...op, start: localDateTimeToISO(op.start, '00:00', op.timeZone), end: localDateTimeToISO(op.end, '00:00', op.timeZone) }
}
export function createSyncController({ store, bridge, intervalMs = 30000 }) {
  const settingsFile = join(store.directory, 'apple-sync.json')
  let running = false, stopped = false, lastError = null, lastRun = null
  async function load() {
    try { return JSON.parse(await readFile(settingsFile, 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') return { enabled: false, links: null }; throw error }
  }
  async function save(value) {
    await mkdir(store.directory, { recursive: true })
    const temp = `${settingsFile}.${randomUUID()}.tmp`
    await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
    await rename(temp, settingsFile)
  }
  async function status() {
    const config = await load()
    let native
    try { native = await bridge.request('status') }
    catch (error) { native = { authorized: false, authorization: 'unavailable', error: error.message, sources: [], calendars: [] } }
    return {
      enabled: !!config.enabled, calendarID: config.calendarID || null,
      calendarName: '日历清单', sourceID: config.sourceID || null,
      running, lastError: lastError || config.lastError || null,
      lastRun: lastRun || config.lastRun || null,
      conflicts: config.conflicts || [], warnings: config.warnings || [], ...native,
    }
  }
  async function configure({ enabled, sourceID }) {
    await store.exclusive(async () => {
      const config = await load()
      if (enabled === false) { await save({ ...config, enabled: false }); return }
      const native = await bridge.request('status')
      if (!native.authorized) throw new Error('请先点击授权，并在 macOS 弹窗允许完整日历访问。')
      if (!config.calendarID) {
        if (!sourceID || !(native.sources || []).some(s => s.id === sourceID)) throw new Error('请选择一个已授权的 iCloud/CalDAV 账户；不会自动使用本机日历。')
        await store.backup('before-apple-sync')
        const initialized = await bridge.request('initialize', { sourceID })
        const calendarID = initialized.calendar?.id
        if (!calendarID) throw new Error('桥接未返回独立日历标识，未启用同步。')
        await save({ ...config, enabled: true, sourceID, calendarID, links: null })
      } else {
        if (sourceID && sourceID !== config.sourceID) throw new Error('暂不支持直接换账户。请先暂停同步并迁移，避免重复事件。')
        await save({ ...config, enabled: true })
      }
    })
    return run()
  }
  function snapshotArgs(config, windowStart, windowEnd) {
    const trackedEventIDs = Object.values(config.links?.entries || {}).map(x => x.eventId).filter(Boolean)
    if (trackedEventIDs.length > 10000) throw new Error('当前最多支持 10000 个已关联事件。请暂停同步并归档历史事项后再启用；数据没有被删除。')
    return { calendarID: config.calendarID, start: windowStart, end: windowEnd, trackedEventIDs }
  }
  async function run() {
    if (running) return { busy: true }
    if (stopped) return { stopped: true }
    running = true
    try {
      return await store.exclusive(async () => {
        let config = await load()
        if (!config.enabled || !config.calendarID) return { skipped: true }
        const now = new Date(), start = new Date(now), end = new Date(now)
        start.setFullYear(start.getFullYear() - 1); end.setFullYear(end.getFullYear() + 2)
        const windowStart = start.toISOString(), windowEnd = end.toISOString()
        const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
        let state = await store.read()
        const snapshot = await bridge.request('snapshot', snapshotArgs(config, windowStart, windowEnd))
        if (!Array.isArray(snapshot.events) || !Array.isArray(snapshot.missingTrackedEventIDs)) throw new Error('Apple 日历返回格式错误；不会将错误视为删除。')
        const safeEvents = snapshot.events.filter(e => e.taskId || e.linkable !== false)
        const args = {
          tasks: state.tasks, events: safeEvents, links: config.links,
          calendarID: config.calendarID, timeZone, now: now.toISOString(), windowStart, windowEnd,
          missingEventIds: snapshot.missingTrackedEventIDs,
          importList: (state.lists.find(x => x.id === 'inbox') || state.lists[0])?.id || 'inbox',
          importGroup: state.groups.find(x => !x.done)?.id || 'g-todo',
        }
        let plan = planSync(args)
        const moved = snapshot.outOfCalendarTrackedEventIDs || []
        const extraWarnings = moved.map(id => ({ code: 'moved-out-of-calendar', eventId: id, message: '事件已移到其他日历；停止更新它，不自动删除或重建。' }))
        snapshot.events.filter(e => !e.taskId && e.linkable === false).forEach(e => extraWarnings.push({ code: 'user-url-preserved', eventId: e.id, message: '事件已有自定义网址，保留网址并跳过同步，避免覆盖。' }))
        function expected(event) {
          if (!event) throw new Error('无法验证事件写入前状态，已中止。')
          return { title: event.title || '', notes: event.notes || null, start: event.start, end: event.end, allDay: !!event.allDay, timeZone: event.timeZone || null, ...(event.lastModified ? { lastModified: event.lastModified } : {}) }
        }
        const claims = []
        for (const [taskId, link] of Object.entries(plan.newLinks?.entries || {})) {
          const event = safeEvents.find(x => x.id === link.eventId)
          if (event && !event.taskId && !event.recurring) claims.push({ op: 'link', id: event.id, taskId, expected: expected(event) })
        }
        if (JSON.stringify(plan.newTasks) !== JSON.stringify(state.tasks) || plan.operations.length || claims.length) await store.backup('apple-sync')
        state = { ...state, tasks: plan.newTasks }
        await store.write(state)
        config = { ...config, links: plan.newLinks, conflicts: plan.conflicts, warnings: [...plan.warnings, ...extraWarnings] }
        await save(config)
        async function batches(operations) {
          for (let offset = 0; offset < operations.length; offset += 500) {
            const applied = await bridge.request('apply', { calendarID: config.calendarID, operations: operations.slice(offset, offset + 500) })
            for (const item of applied.results || []) {
              if (item.event && config.links?.entries[item.taskId]) config.links.entries[item.taskId].eventId = item.event.id
            }
            await save(config)
          }
        }
        if (claims.length) await batches(claims)
        if (plan.operations.length || claims.length) {
          if (plan.operations.length) {
            const operations = plan.operations.map(op => {
              const native = nativeOperation(op)
              if (op.op === 'create') return native
              return { ...native, expected: expected(snapshot.events.find(e => e.id === op.id)) }
            })
            await batches(operations)
          }
          const after = await bridge.request('snapshot', snapshotArgs(config, windowStart, windowEnd))
          if (!Array.isArray(after.events) || !Array.isArray(after.missingTrackedEventIDs)) throw new Error('写入后验证失败；保留同步记录供下次恢复。')
          plan = planSync({ ...args, tasks: state.tasks, events: after.events.filter(e => e.taskId || e.linkable !== false), links: config.links, missingEventIds: after.missingTrackedEventIDs })
          state = { ...state, tasks: plan.newTasks }; await store.write(state)
          config = { ...config, links: plan.newLinks, conflicts: plan.conflicts, warnings: [...plan.warnings, ...extraWarnings] }
        }
        lastRun = new Date().toISOString(); lastError = null
        await save({ ...config, lastRun, lastError: null })
        return { ok: true, lastRun, conflicts: config.conflicts, warnings: config.warnings, taskCount: state.tasks.length }
      })
    } catch (error) { lastError = error.message; throw error }
    finally { running = false }
  }
  const timer = setInterval(() => { if (!stopped) void run().catch(() => {}) }, intervalMs)
  timer.unref?.()
  return { status, configure, run, stop() { stopped = true; clearInterval(timer) } }
}
