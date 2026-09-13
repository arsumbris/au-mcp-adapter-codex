import { describe, it, expect } from 'vitest'
import { codexAdapterInfo, CODEX_NATIVE_TOOLS, GATE_PREFIX } from '../src/surface.ts'
describe('Codex session declaration', () => {
  it('uses canonical hook identities', () => {
    expect(CODEX_NATIVE_TOOLS).toContainEqual({name:'Bash',gateEquivalent:`${GATE_PREFIX}bash`})
    expect(CODEX_NATIVE_TOOLS).toContainEqual({name:'apply_patch',gateEquivalent:`${GATE_PREFIX}edit_file`})
  })
  it('forwards profile and resume without rebinding a common launch handle', () => {
    const info=codexAdapterInfo('child','/v',{resume:true,profile:'[[agent::repo]]'})
    expect(info).toMatchObject({session:'child',profile:'[[agent::repo]]',resume:true,gatePrefix:'mcp__au__'})
    expect(info).not.toHaveProperty('nativeToolAllowlist')
    expect(info).not.toHaveProperty('handle')
    expect(info).not.toHaveProperty('cagedAllow')
  })
})
