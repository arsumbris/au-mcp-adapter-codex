// Actual SDK socket + current daemon, with controlled policy and approval fixtures.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { startDaemon } from '@arsumbris/au-mcp'
import { EventKind, type Plugin, type SessionEvent } from '@arsumbris/au-mcp-sdk'
import { observeEvent, mediateAction, closeSession, sessionStartContext, preToolOutput, recoverStartupContext } from '../src/bridge.ts'
import { registerLaunchSession } from '../src/thread-registry.ts'
import { beginStartup, markStartupContextEmitted } from '../src/startup-readiness.ts'
import { profileEngine } from './profile-engine.ts'

const roots: string[] = []
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root,{recursive:true,force:true}) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(),'au-codex-integration-')); roots.push(root)
  const workspace=join(root,'workspace'); const home=join(root,'home')
  await mkdir(join(workspace,'.arsumbris'),{recursive:true});await mkdir(home)
  vi.stubEnv('CODEX_HOME',home); vi.stubEnv('AU_MCP_WORKSPACE',workspace);vi.stubEnv('AU_MCP_SESSION',randomUUID())
  vi.stubEnv('AU_MCP_PROFILE',undefined);vi.stubEnv('AU_MCP_NATIVE_TOOLS',undefined)
  const session=randomUUID()
  await registerLaunchSession(session,workspace,process.env.AU_MCP_SESSION!)
  return {workspace,payload:{session_id:session,cwd:workspace}}
}
function observer(seen:SessionEvent[]):Plugin {
  return {manifest:{id:'mcp.recorder',name:'recorder',contractVersion:0,kind:'hook',shapes:['observer']},onEvent:(event)=>{seen.push(event)}}
}

describe('Codex bridge against the current daemon',()=>{
  it('delivers only selected tool orientation once, without duplicating descriptions or guidance', async () => {
    const { workspace, payload } = await fixture()
    const engine = await profileEngine(workspace)
    engine.add('selected', ['read_file'])
    vi.stubEnv('AU_MCP_PROFILE', 'selected')
    const plugins: Plugin[] = ['read_file', 'hidden_tool'].map(name => ({
      manifest: { id: `mcp.${name}`, name, kind: 'tool', contractVersion: 0,
        description: `DESCRIPTION_${name}`, guidance: `GUIDANCE_${name}`, provenance: `package_${name}` },
      invoke: async () => ({ content: 'ok' }),
    }))
    const running = await startDaemon({ workspace, plugins })
    try {
      beginStartup({ workspace, session: payload.session_id, handle: process.env.AU_MCP_SESSION! }, payload)
      const delivery = await recoverStartupContext(payload)
      expect(delivery.required).toBe(true)
      expect(delivery.context).toContain('The "au" server')
      expect(delivery.context).toContain('The 1 tools available')
      expect(delivery.context).toContain('read_file (from package_read_file)')
      expect(delivery.context).not.toContain('hidden_tool')
      expect(delivery.context).not.toContain('DESCRIPTION_')
      expect(delivery.context).not.toContain('GUIDANCE_')
      markStartupContextEmitted(delivery)
      expect(await recoverStartupContext(payload)).toMatchObject({ required: false, context: '' })
    } finally { await running.stop(); await engine.close() }
  })
  it('delivers ordered events with native timestamps and closes only its own thread',async()=>{
    const {workspace,payload}=await fixture();const seen:SessionEvent[]=[]
    const running=await startDaemon({workspace,plugins:[observer(seen)]})
    try {
      await observeEvent(payload,EventKind.SessionStart,{source:'startup'})
      await observeEvent(payload,EventKind.UserPrompt,{prompt:'hi',permission_mode:'default'})
      expect((await mediateAction(payload,{tool:'Bash',input:{command:'ls'}})).kind).toBe('allow')
      await observeEvent(payload,EventKind.ToolStart,{tool:'Bash',tool_use_id:'t1'})
      expect(seen.map(e=>e.kind)).toEqual([EventKind.SessionStart,EventKind.UserPrompt,EventKind.ToolStart])
      expect(seen.map(e=>e.seq)).toEqual([1,2,3])
      expect(seen.every(e=>e.session===payload.session_id)).toBe(true)
      expect((seen[1].data as {permission_mode:string}).permission_mode).toBe('default')
      expect(running.daemon.sessionCount()).toBe(1)
      await closeSession(payload);expect(running.daemon.sessionCount()).toBe(0)
    } finally {await running.stop()}
  })
  it('forwards computed startup context and completed-tool review text',async()=>{
    const {workspace,payload}=await fixture()
    const starter:Plugin={manifest:{id:'mcp.starter',name:'starter',contractVersion:0,kind:'hook',shapes:['session-start']},onSessionStart:()=>({inject:['Current profile notice']})}
    const reviewer:Plugin={manifest:{id:'mcp.reviewer',name:'reviewer',contractVersion:0,kind:'hook',shapes:['mediator']},decide:()=>({kind:'allow'}),review:event=>event.kind===EventKind.ToolCall?{text:'Review this result'}:undefined}
    const running=await startDaemon({workspace,plugins:[starter,reviewer]})
    try {
      expect(await sessionStartContext(payload)).toEqual({inject:['Current profile notice']})
      expect(await observeEvent(payload,EventKind.ToolCall,{tool:'write_file'})).toBe('Review this result')
    } finally {await running.stop()}
  })
  it.each(['granted','denied'] as const)('waits for the existing approval path and preserves a %s verdict',async verdict=>{
    const {workspace,payload}=await fixture();const seen:SessionEvent[]=[]
    let answer:((v:typeof verdict)=>void)|undefined
    const approval=vi.fn(()=>new Promise<typeof verdict>(resolve=>{answer=resolve}))
    const policy:Plugin={manifest:{id:'mcp.approval',name:'approval',contractVersion:0,kind:'hook',shapes:['mediator']},decide:async(_action,ctx)=>{
      const result=await ctx.requestApproval({title:'Test approval',reason:'Controlled fixture'})
      return result==='granted'?{kind:'allow'}:{kind:'deny',reason:'Declined'}
    }}
    const running=await startDaemon({workspace,plugins:[observer(seen),policy],approval})
    try {
      let settled=false
      const pending=mediateAction(payload,{tool:'Bash',input:{}}).then(result=>{settled=true;return result})
      await vi.waitFor(()=>expect(approval).toHaveBeenCalledOnce())
      expect(settled).toBe(false)
      answer!(verdict)
      expect((await pending).kind).toBe(verdict==='granted'?'allow':'deny')
      expect(seen.some(event=>event.kind===(verdict==='granted'?EventKind.ApprovalGranted:EventKind.ApprovalDenied))).toBe(true)
    } finally {await running.stop()}
  })
  it('explicitly denies unresolved asks rather than emitting unsupported Codex JSON',async()=>{
    const {workspace,payload}=await fixture()
    const policy:Plugin={manifest:{id:'mcp.ask',name:'ask',contractVersion:0,kind:'hook',shapes:['mediator']},decide:()=>({kind:'ask',reason:'Human required'})}
    const running=await startDaemon({workspace,plugins:[policy]})
    try {expect(preToolOutput(await mediateAction(payload,{tool:'Bash',input:{}}))).toMatchObject({hookSpecificOutput:{permissionDecision:'deny'}})}
    finally {await running.stop()}
  })
  it('denies mediation when the daemon is absent',async()=>{
    const {payload}=await fixture()
    expect((await mediateAction(payload,{tool:'Bash',input:{}})).kind).toBe('deny')
  })
})
