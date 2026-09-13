import { describe, it, expect } from 'vitest'
import { assertSelectedPresent } from '../src/selection.ts'
describe('profile selection completeness',()=>{
  it('allows omitted and explicit empty selections',()=>{
    expect(()=>assertSelectedPresent(undefined,[])).not.toThrow()
    expect(()=>assertSelectedPresent([],[])).not.toThrow()
  })
  it('rejects a stale or mistyped selection instead of silently omitting it',()=>{
    expect(()=>assertSelectedPresent(['owner:one','owner:missing'],[{owner:'owner',name:'one'}])).toThrow('owner:missing')
  })
  it('accepts a complete subset including repeated identical selections',()=>{
    expect(()=>assertSelectedPresent(['owner:one','owner:one'],[{owner:'owner',name:'one'}])).not.toThrow()
  })
})
