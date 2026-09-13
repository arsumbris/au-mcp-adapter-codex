import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { preToolOutput, boundedContext, mediateAction } from '../src/bridge.ts'
import { assertLaunchSession, registerLaunchSession, listLaunchSessions, markLaunchSessionClosed } from '../src/thread-registry.ts'
import { adapterStateDir } from '../src/launch-env.ts'
const created: string[] = []
afterEach(() => { vi.unstubAllEnvs(); for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true }) })
describe('Codex 0.153.2 PreToolUse output', () => {
  it('injects context without invalid bare permissionDecision allow', () => {
    expect(preToolOutput({ kind: 'inject', text: 'read first' })).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'read first' } })
    expect(preToolOutput({ kind: 'allow', note: 'transition complete' })).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'transition complete' } })
    expect(preToolOutput({ kind: 'allow' })).toBeUndefined()
  })
  it('denies unresolved ask rather than letting an unsupported hook fail open', () => {
    expect(preToolOutput({ kind: 'ask', reason: 'delete confirmation' })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('delete confirmation') } })
  })
  it('supplies a nonempty deny reason required by Codex', () => {
    expect(preToolOutput({ kind: 'deny', reason: '' })).toMatchObject({ hookSpecificOutput: { permissionDecisionReason: expect.stringMatching(/\S/) } })
  })
  it('preserves complete Unicode mediation context without an adapter-imposed cap', () => {
    const text = '界'.repeat(100_000)
    expect(preToolOutput({ kind: 'inject', text })).toMatchObject({ hookSpecificOutput: { additionalContext: text } })
    expect(boundedContext(text)).toBe(text)
  })
  it('denies if launch membership is missing, even before connecting', async () => {
    vi.stubEnv('AU_MCP_SESSION', undefined)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try { expect(await mediateAction({ session_id: 'thread' }, { tool: 'Bash', input: {} })).toMatchObject({ kind: 'deny' }) }
    finally { stderr.mockRestore() }
  })
})
describe('launch thread membership', () => {
  it('keeps a parent and two children bound independently and refuses foreign launch/workspace', async () => {
    const home = mkdtempSync(join(tmpdir(), 'au-thread-registry-')); created.push(home); vi.stubEnv('AU_MCP_WORKSPACE', home)
    for (const id of ['parent', 'child-a', 'child-b']) await registerLaunchSession(id, '/workspace/a', 'launch-a')
    for (const id of ['parent', 'child-a', 'child-b']) expect(() => assertLaunchSession(id, '/workspace/a', 'launch-a')).not.toThrow()
    expect(() => assertLaunchSession('parent', '/workspace/a', 'launch-b')).toThrow(/different/)
    expect(() => assertLaunchSession('parent', '/workspace/b', 'launch-a')).toThrow(/different/)
    expect(() => assertLaunchSession('unregistered', '/workspace/a', 'launch-a')).toThrow(/not registered/)
    await expect(registerLaunchSession('../escape', '/workspace/a', 'launch-a')).rejects.toThrow(/invalid/)
    await registerLaunchSession('foreign-launch', '/workspace/a', 'launch-b')
    await registerLaunchSession('foreign-workspace', '/workspace/b', 'launch-a')
    writeFileSync(join(adapterStateDir()!, 'threads', '0'.repeat(64) + '.json'), JSON.stringify({ session: 'forged-name', workspace: '/workspace/a', handle: 'launch-a' }))
    writeFileSync(join(adapterStateDir()!, 'threads', '1'.repeat(64) + '.json'), '{malformed')
    expect(listLaunchSessions('/workspace/a', 'launch-a').sort()).toEqual(['child-a', 'child-b', 'parent'])
    markLaunchSessionClosed('child-a', '/workspace/a', 'launch-a')
    expect(listLaunchSessions('/workspace/a', 'launch-a').sort()).toEqual(['child-b', 'parent'])
    expect(() => assertLaunchSession('child-a', '/workspace/a', 'launch-a')).toThrow(/has closed/)
    expect(() => markLaunchSessionClosed('foreign-launch', '/workspace/a', 'launch-a')).toThrow(/foreign/)
    await registerLaunchSession('child-a', '/workspace/a', 'launch-a')
    expect(() => assertLaunchSession('child-a', '/workspace/a', 'launch-a')).not.toThrow()
  })
})
