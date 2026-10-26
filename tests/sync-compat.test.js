import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createStore } from '../sync/store.js'
import { createStore as legacyStore } from '../store.mjs'
import { createHandler } from '../index.js'
async function withStore(fn) {
  const dir=await mkdtemp(join(tmpdir(),'ticklist-compat-'))
  const store=createStore(dir),legacy=legacyStore(join(dir,'tasks.json'))
  try { await store.write({tasks:[{id:'a',title:'原始'}],lists:[],groups:[]});await fn(store,legacy) }
  finally {await rm(dir,{recursive:true,force:true})}
}
test('Mini SSH and Apple sync share raw revision and lock format',async()=>withStore(async(store,legacy)=>{
  assert.equal(store.publicState(await store.read()).revision,(await legacy.get()).revision)
  const snapshot=await legacy.get()
  await store.exclusive(async()=>{
    assert.ok((await stat(store.file+'.lock')).isDirectory())
    const next=await store.read();next.tasks[0].notes='手机备注';await store.write(next)
  })
  await assert.rejects(legacy.put({...snapshot,expectedRevision:snapshot.revision}),/另一台/)
  const fresh=await legacy.get();fresh.tasks[0].done=true
  await legacy.put({...fresh,expectedRevision:fresh.revision})
  const updated=await store.read();assert.equal(updated.tasks[0].notes,'手机备注');assert.equal(updated.tasks[0].done,true)
}))
function invoke(handler,path,method='GET',data,origin) {
  const req=Readable.from(data?[Buffer.from(JSON.stringify(data))]:[])
  req.method=method;req.url='/ticklist-calendar/'+path;req.socket={remoteAddress:'127.0.0.1'}
  req.headers={host:'127.0.0.1:1234',...(data?{'content-type':'application/json'}:{}),...(origin?{origin}:{})}
  return new Promise((resolve,reject)=>{
    const res={code:null,writeHead(code){this.code=code;return this},end(text){let body;try{body=JSON.parse(text)}catch{body=text}resolve({code:this.code,body})}}
    Promise.resolve(handler(req,res)).catch(reject)
  })
}
test('HTTP preserves Mini config and legacy expectedRevision saves; rejects cross-site',async()=>withStore(async(store)=>{
  const handler=createHandler({config:{mode:'local',hostRole:'mini',sessionDir:'/client'},store,bridge:{},sync:{status:async()=>({authorized:false})}})
  const cfg=await invoke(handler,'config');assert.equal(cfg.body.source,'Mini')
  const state=(await invoke(handler,'api/state')).body
  const result=await invoke(handler,'api/state','PUT',{...state,expectedRevision:state.revision,tasks:[{id:'a',title:'更新'}]})
  assert.equal(result.code,200);assert.equal(result.body.tasks[0].title,'更新')
  assert.equal((await invoke(handler,'api/apple/status','GET',undefined,'https://evil.example')).code,403)
  assert.equal((await invoke(handler,'api/apple/status')).body.authorized,false)
}))
test('remote client refuses local Apple sync instead of silently diverging',async()=>{
  const handler=createHandler({config:{mode:'remote-ssh'},store:null,bridge:null,sync:null})
  const response=await invoke(handler,'api/apple/status')
  assert.equal(response.code,503);assert.match(response.body.error,/Mini/)
})
test('duplicate ids cannot enter disk via same-revision client update',async()=>withStore(async(store)=>{
  const state=store.publicState(await store.read())
  await assert.rejects(store.saveClient({...state,tasks:[{id:'a'},{id:'a'}]}),/重复/)
  assert.equal((await store.read()).tasks.length,1)
}))
