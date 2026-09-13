import { describe, expect, it, vi } from 'vitest'
import { APPROVAL_SCRIPT, resolveLocalAsk, runApprovalProcess } from '../src/approval.ts'
const ask = {kind: 'ask' as const, reason: 'Write this file?'}
const action = {tool: 'apply_patch', input: {patch: 'some patch'}}
const payload = {session_id: 'thread', cwd: '/repo'}

describe('local bare-ask approval', () => {
  it('only grants an explicit successful human response', async () => {
    const prompt = vi.fn(async (_body: string, _timeout: number) => true)
    expect(await resolveLocalAsk(ask, action, payload, Date.now()+10000, prompt)).toMatchObject({kind:'allow'})
    expect(prompt.mock.calls[0][0]).toContain('some patch')
    expect(prompt.mock.calls[0][0]).toContain('thread')
  })
  it('identifies the child when Codex supplies the root session alongside agent_id', async () => {
    const prompt = vi.fn(async (_body: string, _timeout: number) => true)
    await resolveLocalAsk(ask, action, {...payload, agent_id:'child-thread'}, Date.now()+10000, prompt)
    expect(prompt.mock.calls[0][0]).toContain('Session: child-thread')
  })
  it.each([false, 'error'])('fails closed on dismissal or prompt failure', async verdict => {
    expect(await resolveLocalAsk(ask, action, payload, Date.now()+10000, async () => {if (verdict==='error') throw Error('no UI');return false})).toMatchObject({kind:'deny'})
  })
  it('does not prompt for allow/deny or after the action deadline', async () => {
    const prompt = vi.fn(async (_body: string, _timeout: number) => true)
    const deny = {kind:'deny' as const,reason:'policy'}
    expect(await resolveLocalAsk(deny,action,payload,Date.now()+10000,prompt)).toBe(deny)
    expect(await resolveLocalAsk(ask,action,payload,Date.now()-1,prompt)).toMatchObject({kind:'deny'})
    expect(prompt).not.toHaveBeenCalled()
  })
  it('has an independent native timeout and a deny default', () => {
    expect(APPROVAL_SCRIPT).toContain('giving up after')
    expect(APPROVAL_SCRIPT).toContain('default button "Deny"')
  })
  it('checks exit status as well as the exact response', async () => {
    expect(await runApprovalProcess(process.execPath,['-e','process.stdout.write("Approve")'],2000)).toBe(true)
    expect(await runApprovalProcess(process.execPath,['-e','process.stdout.write("Approve");process.exitCode=1'],2000)).toBe(false)
    expect(await runApprovalProcess('/nonexistent/approval',[],2000)).toBe(false)
  })
  it('kills an unanswered prompt within its deadline and removes signal handlers', async () => {
    const before = process.listenerCount('SIGTERM')
    const started = Date.now()
    expect(await runApprovalProcess(process.execPath,['-e','setInterval(()=>{},1000)'],100)).toBe(false)
    expect(Date.now()-started).toBeLessThan(1000)
    expect(process.listenerCount('SIGTERM')).toBe(before)
  })
})
