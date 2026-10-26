import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, writeFile, readFile, chmod, realpath, rm, unlink } from 'node:fs/promises'
import { join, sep } from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'

export function createBridge(root, dataDir) {
  const app = join(os.homedir(), 'Library', 'Application Support', 'TicklistCalendarBridge', 'TicklistCalendarBridge.app')
  const binary = join(app, 'Contents', 'MacOS', 'calendar-bridge')
  const ipcRoot = join(dataDir, 'apple-ipc')
  let writeTail = Promise.resolve()
  async function exists(path) { try { await access(path); return true } catch { return false } }
  async function transport(command, input) {
    if (process.platform !== 'darwin') throw new Error('Apple 日历同步仅支持 macOS。')
    try { await access(binary) } catch { throw new Error('请先构建并安装日历桥接：scripts/build-calendar-bridge.sh 和 scripts/install-calendar-bridge.sh。') }
    await mkdir(ipcRoot, { recursive: true, mode: 0o700 }); await chmod(ipcRoot, 0o700)
    const parent = await realpath(ipcRoot)
    const mutating = command === 'apply' || command === 'initialize'
    const pendingPath = join(parent, 'pending-write.json')
    if (mutating && await exists(pendingPath)) {
      const prior = JSON.parse(await readFile(pendingPath, 'utf8'))
      if (!prior.resultFile?.startsWith(parent + sep) || !await exists(prior.resultFile)) throw new Error('上一轮 Apple 日历写入结果未知，已停止自动重试以免重复。请保留 apple-ipc 目录并联系排查。')
      await unlink(pendingPath) // Output exists: the prior app command finished; snapshot/replan is safe.
    }
    const directory = await mkdtemp(join(parent, 'request-')); await chmod(directory, 0o700)
    const requestFile = join(directory, 'request.json'), resultFile = join(directory, 'result.json')
    await writeFile(requestFile, JSON.stringify({ command, ...input }), { mode: 0o600, flag: 'wx' })
    if (mutating) await writeFile(pendingPath, JSON.stringify({ command, resultFile }), { mode: 0o600, flag: 'wx' })
    let knownResult = false
    try {
      await new Promise((resolve, reject) => {
        // Every command must use the SAME LaunchServices app identity as authorize.
        // Direct executable spawn is attributed to DSH and sees a different TCC grant.
        const child = spawn('/usr/bin/open', ['-n', '-W', app, '--args', 'run', '--request-file', requestFile, '--result-file', resultFile], { stdio: ['ignore', 'ignore', 'pipe'] })
        let errors = '', settled = false
        const finish = error => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve() }
        const timer = setTimeout(() => { child.kill('SIGTERM'); finish(new Error('日历桥接超时。写入结果未知时不会自动重试，请保留同步诊断目录。')) }, 150000)
        child.stderr.on('data', data => { errors += data })
        child.on('error', error => finish(error))
        child.on('close', async code => {
          if (await exists(resultFile)) finish()
          else finish(new Error(errors || `日历桥接未返回结果 (${code})`))
        })
      })
      const text = await readFile(resultFile, 'utf8')
      if (text.length > 16 * 1024 * 1024) throw new Error('日历返回数据过大')
      const result = JSON.parse(text); knownResult = true
      if (!result.ok) throw Object.assign(new Error(result.error?.message || 'Apple 日历请求失败'), { code: result.error?.code })
      return result
    } finally {
      if (mutating && knownResult && await exists(pendingPath)) await unlink(pendingPath)
      // Keep unknown operations for diagnosis; remove only our verified temp directory.
      if (knownResult && directory.startsWith(parent + sep + 'request-')) await rm(directory, { recursive: true })
    }
  }
  function request(command, input = {}) {
    if (command !== 'apply' && command !== 'initialize') return transport(command, input)
    const job = writeTail.then(() => transport(command, input)); writeTail = job.catch(() => {}); return job
  }
  async function authorize() {
    await access(binary); await mkdir(dataDir, { recursive: true })
    const statusFile = join(dataDir, `apple-authorization-${randomUUID()}.json`)
    return new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/open', ['-n', app, '--args', 'authorize', '--status-file', statusFile], { stdio: 'ignore' })
      child.on('error', reject)
      child.on('close', code => code === 0 ? resolve({ requested: true }) : reject(new Error(`无法打开授权程序 (${code})`)))
    })
  }
  return { request, authorize, app, binary }
}
