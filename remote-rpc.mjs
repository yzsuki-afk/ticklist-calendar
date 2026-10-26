// On-demand SSH RPC: no listening port, daemon, local replica, or startup task.
import { createStore } from './store.mjs'
export async function execute(request, store = createStore(process.env.TICKLIST_STORE_FILE)) {
  if (request?.op === 'get') return store.get()
  if (request?.op === 'put') return store.put(request.body)
  const error = new Error('不支持的日历操作'); error.status = 400; throw error
}
const chunks = []; let size = 0
try {
  for await (const chunk of process.stdin) {
    size += chunk.length; chunks.push(chunk)
    if (size > 2 * 1024 * 1024) throw new Error('请求过大')
  }
  const body = await execute(JSON.parse(Buffer.concat(chunks).toString('utf8')))
  process.stdout.write(JSON.stringify({ status: 200, body }) + '\n')
} catch (error) {
  process.stdout.write(JSON.stringify({ status: error.status || 503, body: { error: error.message } }) + '\n')
}
