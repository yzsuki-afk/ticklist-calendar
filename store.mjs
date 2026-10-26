import { readFile, writeFile, mkdir, rename, unlink, rmdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import os from 'node:os'

export class StoreError extends Error {
  constructor(status, message) { super(message); this.status = status }
}
export const defaultFile = join(os.homedir(), '.dsh/storages/ticklist-calendar/tasks.json')
const digest = raw => createHash('sha256').update(raw).digest('hex')
function stateOf(value) {
  if (!value || !Array.isArray(value.tasks) || !Array.isArray(value.lists) || !Array.isArray(value.groups)) throw new StoreError(400, '清单、分组和任务必须为数组')
  const ids = new Set()
  for (const task of value.tasks) {
    if (!task || typeof task.id !== 'string' || !task.id || ids.has(task.id)) throw new StoreError(400, '任务 ID 无效或重复')
    ids.add(task.id)
  }
  return { lists: value.lists, groups: value.groups, tasks: value.tasks }
}
export function createStore(file = defaultFile) {
  async function get() {
    let raw
    try { raw = await readFile(file, 'utf8') }
    catch (error) { if (error.code === 'ENOENT') return { lists: [], groups: [], tasks: [], revision: digest('') }; throw error }
    try {
      const data = JSON.parse(raw)
      const state = stateOf({lists: data.lists || [], groups: data.groups || [], tasks: data.tasks})
      return { ...state, revision: digest(raw) }
    } catch { throw new StoreError(503, 'Mini 日历数据无法解析；已停止读写，原文件保持不变') }
  }
  async function put(input) {
    if (typeof input?.expectedRevision !== 'string') throw new StoreError(428, '请刷新到新版页面后再保存（缺少版本号）')
    const next = stateOf(input)
    await mkdir(dirname(file), { recursive: true })
    const lock = file + '.lock'
    const deadline = Date.now() + 4000
    for (;;) {
      try { await mkdir(lock); break }
      catch (error) {
        if (error.code !== 'EEXIST') throw error
        if (Date.now() >= deadline) throw new StoreError(503, 'Mini 日历正在保存或锁未释放，请稍后刷新；不要强行覆盖')
        await new Promise(resolve => setTimeout(resolve, 30))
      }
    }
    const temp = file + '.tmp-' + randomUUID()
    try {
      const current = await get()
      if (current.revision !== input.expectedRevision) throw new StoreError(409, '另一台电脑已修改日历，请刷新后重试；本次未覆盖')
      const raw = JSON.stringify(next, null, 2) + '\n'
      await writeFile(temp, raw, { flag: 'wx', mode: 0o600 })
      await rename(temp, file)
      return { ok: true, revision: digest(raw) }
    } finally {
      // Only remove the uniquely-created temporary file and this operation's lock.
      try { await unlink(temp) } catch (error) { if (error.code !== 'ENOENT') throw error }
      finally { await rmdir(lock) }
    }
  }
  return { get, put }
}
