import { readFile, writeFile, mkdir, rename, copyFile, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b)
const digest = raw => createHash('sha256').update(raw).digest('hex')
const rawRevision = Symbol('diskRevision')
export const revisionOf = state => state[rawRevision] || digest(JSON.stringify(state))
export class StateConflict extends Error { constructor(message) { super(message); this.status = 409 } }
export function mergeState(base, local, remote) {
  const result = { ...remote }
  for (const collection of ['tasks','lists','groups']) {
    const a = new Map((base[collection] || []).map(x=>[x.id,x]))
    const b = new Map((local[collection] || []).map(x=>[x.id,x]))
    const c = new Map((remote[collection] || []).map(x=>[x.id,x]))
    const rows = []
    for (const id of new Set([...c.keys(),...b.keys(),...a.keys()])) {
      const before=a.get(id), mine=b.get(id), theirs=c.get(id)
      if (equal(mine,before)) { if (theirs) rows.push(theirs); continue }
      if (equal(theirs,before) || equal(mine,theirs)) { if (mine) rows.push(mine); continue }
      if (!mine || !theirs || !before) throw new StateConflict(`${id} 已被另一端修改，请先复制当前内容再刷新。`)
      const merged={...theirs}
      for (const field of new Set([...Object.keys(before),...Object.keys(mine),...Object.keys(theirs)])) {
        if (equal(mine[field],before[field])) continue
        if (!equal(theirs[field],before[field]) && !equal(mine[field],theirs[field])) throw new StateConflict(`${id} 的 ${field} 已被另一端修改，请先复制当前内容再刷新。`)
        if (field in mine) merged[field]=mine[field]; else delete merged[field]
      }
      rows.push(merged)
    }
    result[collection]=rows
  }
  return result
}
function validate(state) {
  for (const collection of ['tasks','lists','groups']) {
    const rows=state[collection], ids=new Set()
    if (!Array.isArray(rows)) throw Object.assign(new Error(`${collection} 必须为数组`),{status:400})
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.id !== 'string' || !row.id || ids.has(row.id)) throw Object.assign(new Error(`${collection} 包含无效或重复 ID，未保存`),{status:400})
      ids.add(row.id)
    }
  }
}
export function createStore(directory) {
  const file=join(directory,'tasks.json'), lock=file+'.lock'
  let tail=Promise.resolve()
  // Same filesystem lock + raw-file revision as Mini's existing SSH backend.
  async function locked(fn) {
    await mkdir(directory,{recursive:true})
    const deadline=Date.now()+4000
    for (;;) {
      try { await mkdir(lock); break }
      catch(error) {
        if(error.code!=='EEXIST') throw error
        if(Date.now()>=deadline) throw Object.assign(new Error('Mini 日历正忙或锁未释放，请稍后重试；不会覆盖数据。'),{status:503})
        await new Promise(resolve=>setTimeout(resolve,30))
      }
    }
    try { return await fn() } finally { await rmdir(lock) }
  }
  const exclusive=fn=>{const job=tail.then(()=>locked(fn));tail=job.catch(()=>{});return job}
  async function read() {
    let raw
    try {raw=await readFile(file,'utf8')} catch(error){if(error.code!=='ENOENT')throw error;raw=''}
    const state=raw?JSON.parse(raw):{lists:[],groups:[],tasks:[]}
    state.lists ||= []; state.groups ||= []; validate(state)
    Object.defineProperty(state,rawRevision,{value:digest(raw)})
    return state
  }
  async function write(state) {
    validate(state); await mkdir(directory,{recursive:true})
    const temp=`${file}.${randomUUID()}.tmp`
    await writeFile(temp,JSON.stringify(state,null,2)+'\n',{mode:0o600});await rename(temp,file)
  }
  async function backup(label='apple-sync') {
    await mkdir(directory,{recursive:true})
    const target=join(directory,`tasks.${label}.${Date.now()}.${randomUUID()}.json`)
    try {await copyFile(file,target);return target} catch(error){if(error.code==='ENOENT')return null;throw error}
  }
  const publicState=state=>({...state,revision:revisionOf(state)})
  async function saveClient(request) {
    return exclusive(async()=>{
      const current=await read(), next={lists:request.lists||[],groups:request.groups||[],tasks:request.tasks}
      validate(next)
      const revision=request.revision||request.expectedRevision
      let merged
      if(revision===revisionOf(current))merged={...current,...next}
      else if(request.base&&request.revision){validate(request.base);merged=mergeState(request.base,next,current)}
      else throw new StateConflict('页面数据已过期，请刷新后再编辑。为防止覆盖手机端数据，本次保存被拒绝。')
      await write(merged);return publicState(await read())
    })
  }
  return {directory,file,read,write,backup,exclusive,publicState,saveClient}
}
