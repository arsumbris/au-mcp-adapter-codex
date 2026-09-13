import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { startDaemon } from '@arsumbris/au-mcp'
import type { SessionEvent } from '@arsumbris/au-mcp-sdk'
vi.mock('../src/bridge.ts', async original => {
  const bridge = await original<typeof import('../src/bridge.ts')>()
  return { ...bridge, observeEvents: vi.fn(bridge.observeEvents), sendRehydrate: vi.fn(bridge.sendRehydrate) }
})
import { observeEvents, sendRehydrate, recoverStartupContext } from '../src/bridge.ts'
import { liftRollout, rehydrateSession, finalizeSession } from '../src/lift.ts'
import { adapterDeviceDir } from '../src/launch-env.ts'
import { registerLaunchSession } from '../src/thread-registry.ts'
import { beginStartup, markStartupContextEmitted } from '../src/startup-readiness.ts'
const original = await vi.importActual<typeof import('../src/bridge.ts')>('../src/bridge.ts')
const roots: string[] = []
const daemons: Array<Awaited<ReturnType<typeof startDaemon>>> = []
beforeEach(() => {
  vi.mocked(observeEvents).mockReset().mockImplementation(original.observeEvents)
  vi.mocked(sendRehydrate).mockReset().mockImplementation(original.sendRehydrate)
})
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop()
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const message = (id: string) => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', id, content: [{ type: 'output_text', text: id }] } }) + '\n'
async function fixture() {
  const workspace = mkdtempSync(join(tmpdir(), 'au-lift-delivery-')); roots.push(workspace)
  mkdirSync(join(workspace, '.arsumbris'))
  const session = randomUUID(), handle = randomUUID()
  vi.stubEnv('AU_MCP_WORKSPACE', workspace); vi.stubEnv('AU_MCP_SESSION', handle); vi.stubEnv('AU_MCP_PROFILE', undefined)
  const transcript = join(workspace, 'rollout.jsonl')
  writeFileSync(transcript, message('one') + message('two'))
  const payload = { session_id: session, cwd: workspace, source: 'startup', transcript_path: transcript }
  const recorded: SessionEvent[] = []
  daemons.push(await startDaemon({ workspace, plugins: [{
    manifest: { id: 'mcp.recorder', name: 'recorder', kind: 'hook', shapes: ['observer'], contractVersion: 0 },
    onEvent: event => { recorded.push(event) },
  }] }))
  await registerLaunchSession(session, workspace, handle)
  const identity = { session, workspace, handle }
  beginStartup(identity, payload)
  markStartupContextEmitted(await recoverStartupContext(payload))
  return { workspace, payload, identity, recorded, transcript }
}

it('retries a lost acknowledgement without recording the accepted event twice', async () => {
  const { payload, recorded, workspace } = await fixture()
  vi.mocked(observeEvents).mockImplementationOnce(async (p, events) => {
    await original.observeEvents(p, events.slice(0, 1))
    return 0 // the daemon accepted one event, but its acknowledgement was lost
  })
  await liftRollout(payload)
  await liftRollout(payload)
  expect(recorded.map(event => event.dedupeKey)).toEqual(['one', 'two'])
  expect(vi.mocked(observeEvents).mock.calls[1][1].map(event => event.dedupeKey)).toEqual(['one', 'two'])
  expect(existsSync(join(workspace, 'operations'))).toBe(false)
})

it('concurrent captures record each event once through the kernel', async () => {
  const { payload, recorded } = await fixture()
  await Promise.all([liftRollout(payload), liftRollout(payload)])
  expect(recorded.map(event => event.dedupeKey).sort()).toEqual(['one', 'two'])
})

it('losing a cursor causes a safe reread and still captures subsequent events', async () => {
  const { payload, recorded, transcript } = await fixture()
  await liftRollout(payload)
  rmSync(join(adapterDeviceDir(), 'lift'), { recursive: true })
  appendFileSync(transcript, message('three'))
  await liftRollout(payload)
  expect(recorded.map(event => event.dedupeKey)).toEqual(['one', 'two', 'three'])
})

it('keeps history inert after a failed replay, including the first full reread after recovery', async () => {
  const { payload, identity, recorded } = await fixture()
  const resumed = { ...payload, source: 'resume' }
  beginStartup(identity, resumed)
  vi.mocked(sendRehydrate).mockResolvedValueOnce(undefined)
  await expect(recoverStartupContext(resumed)).rejects.toThrow('history')
  await liftRollout(resumed)
  expect(recorded).toEqual([])
  markStartupContextEmitted(await recoverStartupContext(resumed))
  await liftRollout(resumed)
  expect(recorded).toEqual([]) // replay seeded the kernel's keys; no observer fan-out
})

it('requires complete replay acknowledgement and a readable transcript', async () => {
  const { payload } = await fixture()
  vi.mocked(sendRehydrate).mockResolvedValueOnce({ injected: 0, refused: 0 }).mockResolvedValueOnce({ injected: 1, refused: 1 })
  expect(await rehydrateSession(payload)).toBe(false)
  expect(await rehydrateSession(payload)).toBe(false)
  expect(await rehydrateSession(payload)).toBe(true)
  writeFileSync(payload.transcript_path, '')
  expect(await rehydrateSession(payload)).toBe(true)
  expect(await rehydrateSession({ ...payload, transcript_path: '/nonexistent-rollout' })).toBe(false)
})

it('captures a short final tail even when the transcript is large, then closes the session', async () => {
  const { payload, recorded, transcript } = await fixture()
  appendFileSync(transcript, JSON.stringify({ type: 'irrelevant', padding: 'x'.repeat(2_100_000) }) + '\n')
  await liftRollout(payload)
  appendFileSync(transcript, message('final'))
  await finalizeSession(payload, Date.now() + 2200)
  expect(recorded.map(event => event.dedupeKey ?? event.kind)).toEqual(['one', 'two', 'final', 'session_end'])
})
