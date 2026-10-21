/**
 * TickList 日历 · Host 半边
 *
 * 职责（只做三件事，不碰 DSH 内部状态）：
 *   1. 把 app/index.html 挂到 /ticklist-calendar/ 下
 *   2. 提供 GET/PUT /ticklist-calendar/api/state 读写任务数据
 *   3. 数据存成本机 JSON 文件，不依赖任何数据库
 *
 * 为什么整份状态一起存取而不是按任务增删：
 * 任务量在个人使用级别（几十到几百条），整份替换最简单、最不容易出现
 * 「前端内存与后端不一致」的问题。写入用原子替换，避免半截文件。
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP_DIR = join(HERE, 'app')

/** 同源路由前缀，Client 半边也用它拼 iframe 地址。 */
const ROUTE_PREFIX = '/ticklist-calendar'

/** 数据文件：放在 dsh 目录下，避免污染项目工作区。 */
const DATA_DIR = join(os.homedir(), '.dsh', 'storages', 'ticklist-calendar')
const DATA_FILE = join(DATA_DIR, 'tasks.json')

/** 首次运行的空状态。 */
const EMPTY_STATE = { lists: [], groups: [], tasks: [] }

async function readState() {
  try {
    const text = await readFile(DATA_FILE, 'utf8')
    const parsed = JSON.parse(text)
    return {
      lists: Array.isArray(parsed.lists) ? parsed.lists : [],
      groups: Array.isArray(parsed.groups) ? parsed.groups : [],
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : []
    }
  } catch (error) {
    // 文件不存在或损坏：返回空状态，不抛错（避免整个页面 500）
    if (error?.code === 'ENOENT') return EMPTY_STATE
    if (error instanceof SyntaxError) {
      // 损坏文件先备份，再重置，避免用户数据被静默覆盖
      try {
        await rename(DATA_FILE, `${DATA_FILE}.corrupt-${Date.now()}`)
      } catch {}
      return EMPTY_STATE
    }
    throw error
  }
}

async function writeState(next) {
  await mkdir(DATA_DIR, { recursive: true })
  const tmp = `${DATA_FILE}.tmp`
  await writeFile(tmp, JSON.stringify(next, null, 2), 'utf8')
  await rename(tmp, DATA_FILE)   // 原子替换
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  res.end(body)
}

async function readBody(req, limit = 2 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function apply(ctx) {
  // Host 需要 webServer 才能挂路由；没有它的 profile 里这个插件静默不激活
  ctx.inject(['webServer'], (service) => {
    const webServer = service?.webServer ?? ctx.webServer

    const dispose = webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const sub = url.pathname.slice(ROUTE_PREFIX.length) || '/'

          // ---- 数据接口 ----
          if (sub === '/api/state') {
            if (req.method === 'GET') {
              return sendJson(res, 200, await readState())
            }
            if (req.method === 'PUT') {
              const raw = await readBody(req)
              const parsed = JSON.parse(raw)
              if (!Array.isArray(parsed?.tasks)) {
                return sendJson(res, 400, { error: 'tasks must be an array' })
              }
              await writeState({
                lists: Array.isArray(parsed.lists) ? parsed.lists : [],
                groups: Array.isArray(parsed.groups) ? parsed.groups : [],
                tasks: parsed.tasks
              })
              return sendJson(res, 200, { ok: true })
            }
            res.writeHead(405).end()
            return
          }

          // ---- 页面 ----
          if (req.method !== 'GET') {
            res.writeHead(405).end()
            return
          }

          const page = sub === '/' || sub === '' ? 'index.html' : sub.replace(/^\//, '')
          const target = join(APP_DIR, page)

          // 防目录穿越
          if (!target.startsWith(APP_DIR)) {
            res.writeHead(403).end()
            return
          }
          if (!existsSync(target)) {
            res.writeHead(404).end('not found')
            return
          }

          const html = await readFile(target, 'utf8')
          const type = target.endsWith('.html')
            ? 'text/html; charset=utf-8'
            : 'application/octet-stream'
          res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' })
          res.end(html)
        } catch (error) {
          // 任何异常都返回明确错误，不留挂起的请求
          sendJson(res, 500, { error: String(error?.message ?? error) })
        }
      }
    })

    return () => dispose()
  })
}
