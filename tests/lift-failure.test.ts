import { it, expect } from 'vitest'
import { extractLifted, extractObservable } from '../src/lift.ts'
const rows = [
  {timestamp:'2026-09-05T17:00:00Z',type:'response_item',payload:{type:'function_call',name:'exec_command',call_id:'c1',arguments:'{"cmd":"exit 7"}'}},
  {timestamp:'2026-09-05T17:00:01Z',type:'event_msg',payload:{type:'item_completed',item:{type:'CommandExecution',id:'c1',status:'failed',exit_code:7}}},
  {timestamp:'2026-09-05T17:00:02Z',type:'response_item',payload:{type:'message',id:'a1',role:'assistant',content:[{type:'output_text',text:'Command failed.'}]}},
].map(row=>JSON.stringify(row)).join('\n')
it('captures the native failure before the following assistant reply with stable keys for both',()=>{
  const first=extractLifted(rows)
  expect(first.events.map(e=>e.kind)).toEqual(['tool_failed','assistant_message'])
  expect(extractLifted(rows).events).toEqual(first.events)
})
it('rehydrates failure identity with original tool arguments',()=>{
  const events=extractObservable(rows)
  expect(events[0]).toMatchObject({kind:'tool_failed',data:{tool:'Bash',tool_use_id:'c1',input:{cmd:'exit 7'},exit_code:7}})
})
