/** 日历清单 Host：保留 Mini/SSH 数据源，Apple 同步只在数据源 Mac 运行。 */
import { readFile, mkdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve, sep, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import { createStore } from './sync/store.js'
import { createBridge } from './sync/bridge.js'
import { createSyncController } from './sync/controller.js'
import { remoteCall } from './ssh-backend.mjs'
const HERE = dirname(fileURLToPath(import.meta.url)), APP_DIR = join(HERE, 'app')
const PREFIX = '/ticklist-calendar', DATA_DIR = join(os.homedir(), '.dsh', 'storages', 'ticklist-calendar')
export function loadConfig() {
  const sessionDir = join(os.homedir(), '.dsh', 'calendar-client')
  try {
    const value = JSON.parse(readFileSync(join(DATA_DIR, 'connection.json'), 'utf8'))
    if (!['local', 'remote-ssh'].includes(value.mode) || (value.mode === 'local' && value.hostRole !== 'mini')) throw new Error('日历连接模式无效')
    return { sessionDir, ...value }
  } catch (error) {
    if (error.code === 'ENOENT') return { mode: 'local', hostRole: 'standalone', sessionDir }
    return { mode: 'unconfigured', sessionDir, error: '日历连接配置无效，已停止读写；不会回退本机旧数据。' }
  }
}
function sendJson(res,status,value) {
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value))
}
async function readBody(req) {
  const chunks=[];let size=0
  for await(const chunk of req){size+=chunk.length;if(size>2*1024*1024)throw Object.assign(new Error('请求过大'),{status:413});chunks.push(chunk)}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
function requireLocalRequest(req) {
  const host = new URL('http://' + req.headers.host)
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname)) throw Object.assign(new Error('拒绝非本机 Host'), {status:403})
  const address=req.socket?.remoteAddress
  if(address&&!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address))throw Object.assign(new Error('日历接口仅允许本机访问'),{status:403})
  const origin=req.headers.origin
  if(origin&&origin!==`http://${req.headers.host}`&&origin!==`https://${req.headers.host}`)throw Object.assign(new Error('拒绝跨站请求'),{status:403})
  if(!['GET','HEAD'].includes(req.method)&&!req.headers['content-type']?.startsWith('application/json'))throw Object.assign(new Error('必须使用 JSON 请求'),{status:415})
}
export function createHandler({ config, store, bridge, sync }) {
  return async(req,res)=>{
    try {
      const sub=new URL(req.url??'/','http://localhost').pathname.slice(PREFIX.length)||'/'
      if(sub.startsWith('/api/')||sub==='/config')requireLocalRequest(req)
      if(sub==='/config'&&req.method==='GET') {
        if(config.mode==='unconfigured')return sendJson(res,503,{error:config.error})
        return sendJson(res,200,{mode:config.mode,source:config.hostRole==='standalone'?'本机':'Mini',sessionDir:config.sessionDir})
      }
      if(sub==='/api/state') {
        if(config.mode==='unconfigured')return sendJson(res,503,{error:config.error})
        if(config.mode==='remote-ssh') {
          let result
          if(req.method==='GET')result=await remoteCall(config,{op:'get'})
          else if(req.method==='PUT') {
            const data=await readBody(req)
            result=await remoteCall(config,{op:'put',body:{...data,expectedRevision:data.revision||data.expectedRevision}})
            if(result.status===200)result=await remoteCall(config,{op:'get'})
          } else return sendJson(res,405,{error:'method not allowed'})
          return sendJson(res,result.status,{...result.body,source:'Mini'})
        }
        if(req.method==='GET')return sendJson(res,200,store.publicState(await store.read()))
        if(req.method==='PUT') {
          const parsed=await readBody(req)
          if(!Array.isArray(parsed?.tasks))return sendJson(res,400,{error:'tasks must be an array'})
          return sendJson(res,200,await store.saveClient(parsed))
        }
        return sendJson(res,405,{error:'method not allowed'})
      }
      if(sub.startsWith('/api/apple/')) {
        if(config.mode!=='local')return sendJson(res,503,{error:'Apple 日历同步请在 Mini 数据源的 DSH 中设置；此客户端不会改用本机旧数据。'})
        if(sub==='/api/apple/status'&&req.method==='GET')return sendJson(res,200,await sync.status())
        if(sub==='/api/apple/authorize'&&req.method==='POST') {
          await readBody(req);await mkdir(DATA_DIR,{recursive:true});return sendJson(res,200,await bridge.authorize())
        }
        if(sub==='/api/apple/configure'&&req.method==='POST')return sendJson(res,200,await sync.configure(await readBody(req)))
        if(sub==='/api/apple/sync'&&req.method==='POST'){await readBody(req);return sendJson(res,200,await sync.run())}
      }
      if(sub.startsWith('/api/'))return sendJson(res,404,{error:'not found'})
      if(req.method!=='GET'){res.writeHead(405).end();return}
      const target=resolve(APP_DIR,sub==='/'?'index.html':sub.replace(/^\//,''))
      if(!target.startsWith(APP_DIR+sep)){res.writeHead(403).end();return}
      const type={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'}[extname(target)]||'application/octet-stream'
      const content=await readFile(target);res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'});res.end(content)
    } catch(error){sendJson(res,error.status||(error.code==='ENOENT'?404:500),{error:error.message})}
  }
}
export function apply(ctx) {
  const config=loadConfig()
  ctx.inject(['webServer'],service=>{
    const server=service?.webServer??ctx.webServer,store=createStore(DATA_DIR),bridge=createBridge(HERE,DATA_DIR)
    const sync=config.mode==='local'?createSyncController({store,bridge}):null
    const dispose=server.register({kind:'prefix',path:PREFIX,handler:createHandler({config,store,bridge,sync})})
    return ()=>{sync?.stop();dispose()}
  })
}
