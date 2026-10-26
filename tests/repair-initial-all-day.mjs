// Opt-in recovery for the initial macOS EventKit all-day setter-order defect.
// Repairs only newly created marker-linked, unbased events whose fields exactly
// match the corresponding current task and the recorded failure. No force merge.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import os from 'node:os'
import { createBridge } from '../sync/bridge.js'
import { nativeOperation } from '../sync/controller.js'
import { localDateTimeToISO } from '../sync/planner.js'
if (process.env.TICKLIST_REPAIR_ALL_DAY !== '1') throw new Error('Requires explicit TICKLIST_REPAIR_ALL_DAY=1')
const base=process.env.TICKLIST_TEST_ORIGIN
if(!base||!/^http:\/\/127\.0\.0\.1:\d+$/.test(base))throw new Error('Explicit local DSH URL required')
const dataDir=join(os.homedir(),'.dsh','storages','ticklist-calendar')
const bridge=createBridge(process.cwd(),dataDir)
async function api(path){const r=await fetch(base+'/ticklist-calendar/'+path);if(!r.ok)throw new Error('API '+r.status);return r.json()}
const status=await api('api/apple/status'), state=await api('api/state')
assert.equal(status.enabled,false,'Pause automatic sync before repair')
assert.ok(status.calendarID&&status.authorized)
const config=JSON.parse(await readFile(join(dataDir,'apple-sync.json'),'utf8'))
const candidates=status.conflicts.filter(c=>c.type==='unbased-divergence'&&c.local?.schedule.allDay===true&&c.remote?.schedule.allDay===false)
const now=new Date(),start=new Date(now),end=new Date(now);start.setFullYear(start.getFullYear()-1);end.setFullYear(end.getFullYear()+2)
const snapshot=await bridge.request('snapshot',{calendarID:status.calendarID,start:start.toISOString(),end:end.toISOString(),trackedEventIDs:candidates.map(c=>c.eventId)})
const operations=[]
for(const conflict of candidates){
 const task=state.tasks.find(t=>t.id===conflict.taskId),event=snapshot.events.find(e=>e.id===conflict.eventId),link=config.links?.entries[conflict.taskId]
 if(!task||!event||!link||link.baseline!==null||link.eventId!==event.id||event.taskId!==task.id||event.allDay||event.recurring||task.start)continue
 const s=conflict.local.schedule
 if(task.date!==s.start||task.title!==conflict.local.title||String(task.notes||'')!==conflict.local.notes)continue
 const startInstant=localDateTimeToISO(s.start,'00:00',s.timeZone),endInstant=localDateTimeToISO(s.end,'00:00',s.timeZone)
 if(event.title!==task.title||String(event.notes||'')!==String(task.notes||'')||event.start!==startInstant||event.end!==endInstant||event.timeZone!==s.timeZone)continue
 const expected={title:event.title,notes:event.notes||null,start:event.start,end:event.end,allDay:false,timeZone:event.timeZone,lastModified:event.lastModified}
 operations.push({...nativeOperation({op:'update',id:event.id,taskId:task.id,allDay:true,start:s.start,end:s.end,timeZone:s.timeZone}),expected})
}
if(operations.length){
 await bridge.request('apply',{calendarID:status.calendarID,operations})
 const verified=await bridge.request('snapshot',{calendarID:status.calendarID,start:start.toISOString(),end:end.toISOString(),trackedEventIDs:operations.map(op=>op.id)})
 for(const op of operations){const event=verified.events.find(e=>e.id===op.id);assert.ok(event?.allDay,'Repaired event must stay all day');assert.equal(event.start,op.start);assert.equal(event.end,op.end)}
}
console.log(JSON.stringify({candidates:candidates.length,repaired:operations.length,skipped:candidates.length-operations.length}))
