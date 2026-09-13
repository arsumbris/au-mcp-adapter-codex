import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { startDaemon } from '@arsumbris/au-mcp'
import { EventKind, type Plugin, type SessionEvent } from '@arsumbris/au-mcp-sdk'
import { recoverStartupContext, mediateAction } from '../src/bridge.ts'
import { beginStartup, markStartupContextEmitted } from '../src/startup-readiness.ts'
import { registerLaunchSession } from '../src/thread-registry.ts'
import { liftRollout } from '../src/lift.ts'
import { adapterDeviceDir } from '../src/launch-env.ts'

afterEach(() => vi.unstubAllEnvs())
it('restores observable history after daemon replacement without emitting historical actions as live', async () => {
  const root = mkdtempSync(join(tmpdir(), 'au-hydration-restart-'))
  const workspace = join(root, 'workspace'), home = join(root, 'home')
  mkdirSync(join(workspace, '.arsumbris'), { recursive: true }); mkdirSync(home)
  const session = randomUUID(), handle = randomUUID()
  vi.stubEnv('CODEX_HOME', home)
  vi.stubEnv('AU_MCP_WORKSPACE', workspace); vi.stubEnv('AU_MCP_SESSION', handle); vi.stubEnv('AU_MCP_PROFILE', undefined)
  const transcript = join(root, 'rollout.jsonl')
  writeFileSync(transcript, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'history-marker', content: [{ type: 'output_text', text: 'RESTORED_HISTORY_SENTINEL' }] } }) + '\n')
  const payload = { session_id: session, cwd: workspace, source: 'startup', transcript_path: transcript }
  const seen: SessionEvent[] = []
  let consulted: SessionEvent[] = []
  const plugins: Plugin[] = [
    { manifest: { id: 'mcp.observer', name: 'observer', kind: 'hook', shapes: ['observer'], contractVersion: 0 }, onEvent: event => { seen.push(event) } },
    { manifest: { id: 'mcp.reader', name: 'reader', kind: 'hook', shapes: ['mediator'], contractVersion: 0 }, decide: async (_action, context) => {
      consulted = (await context.consultTrace({ kinds: [EventKind.AssistantMessage] })).events
      return { kind: 'allow' }
    } },
  ]
  let running: Awaited<ReturnType<typeof startDaemon>> | undefined
  try {
    await registerLaunchSession(session, workspace, handle)
    beginStartup({ session, workspace, handle }, payload)
    running = await startDaemon({ workspace, plugins })
    markStartupContextEmitted(await recoverStartupContext(payload))
    await liftRollout(payload)
    expect(seen.filter(event => event.kind === EventKind.AssistantMessage)).toHaveLength(1)
    await running.stop()
    running = await startDaemon({ workspace, plugins })
    rmSync(join(adapterDeviceDir(), 'lift'), { recursive: true, force: true })
    await liftRollout(payload)
    expect(seen.filter(event => event.kind === EventKind.AssistantMessage)).toHaveLength(1)
    const delivery = await recoverStartupContext(payload)
    expect(delivery.required).toBe(true)
    markStartupContextEmitted(delivery)
    await liftRollout(payload)
    expect((await mediateAction(payload, { tool: 'fixture', input: {} })).kind).toBe('allow')
    expect(consulted).toHaveLength(1)
    expect(JSON.stringify(consulted)).toContain('RESTORED_HISTORY_SENTINEL')
    expect(seen.filter(event => event.kind === EventKind.AssistantMessage)).toHaveLength(1)
    expect((await recoverStartupContext(payload)).required).toBe(false)
    await mediateAction(payload, { tool: 'fixture', input: {} })
    expect(consulted).toHaveLength(1)
  } finally { await running?.stop(); rmSync(root, { recursive: true, force: true }) }
}, 15000)
