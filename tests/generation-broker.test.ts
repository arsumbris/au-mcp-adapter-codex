import { it, expect, vi } from 'vitest'
import type { EngineBroker } from '@arsumbris/au-mcp'
import { withGenerationBroker } from '../src/generation-broker.ts'
const fake = (over: Partial<EngineBroker> = {}): EngineBroker => ({socketPath:'/tmp/test-engine.sock',available:()=>true,read:async()=>({result:[]}),mutate:async()=>({}),...over})
it('fails an absent daemon instead of declaring an empty profile',async()=>{
  const run=vi.fn(async()=>[])
  await expect(withGenerationBroker('/workspace',run,()=>fake({available:()=>false}))).rejects.toThrow('unavailable')
  expect(run).not.toHaveBeenCalled()
})
it('retains a read failure even when shared discovery catches it',async()=>{
  const close=vi.fn()
  await expect(withGenerationBroker('/workspace',async broker=>{await broker.read('instances_of').catch(()=>null);return []},()=>fake({read:async()=>{throw new Error('lost connection')},close}))).rejects.toThrow('lost connection')
  expect(close).toHaveBeenCalledOnce()
})
it.each([{type:'error',message:'bad schema'},{ready:false},{result:null}])('rejects an error or malformed discovery frame',async frame=>{
  await expect(withGenerationBroker('/workspace',broker=>broker.read('instances_of'),()=>fake({read:async()=>frame}))).rejects.toThrow(/Engine/)
})
it('accepts a valid empty workspace response',async()=>{
  await expect(withGenerationBroker('/workspace',broker=>broker.read('instances_of'),()=>fake())).resolves.toEqual({result:[]})
})
