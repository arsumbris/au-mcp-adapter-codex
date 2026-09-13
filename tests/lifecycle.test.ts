import { beforeEach, afterEach, it, expect, vi } from 'vitest'
const state = vi.hoisted(() => ({ active: false, run: 0 }))
const client = vi.hoisted(() => ({
  sessionOpen: vi.fn(async () => { if (!state.active) { state.active = true; state.run++ } }),
  sessionClose: vi.fn(async () => { state.active = false }),
  observe: vi.fn(async () => undefined),
  turnEnd: vi.fn(async () => undefined),
  dispose: vi.fn(),
}))
const transport = vi.hoisted(() => ({ close: vi.fn() }))
vi.mock('@arsumbris/au-mcp-sdk', async (original) => ({
  ...await original<typeof import('@arsumbris/au-mcp-sdk')>(),
  connectSocket: vi.fn(async () => transport),
  createDaemonClient: vi.fn(() => client),
}))
vi.mock('../src/session-open.ts', () => ({ openCodexSession: vi.fn(async (backend: typeof client) => { await backend.sessionOpen() }), currentDaemonIdentity: vi.fn(() => 'fixture-daemon') }))
vi.mock('../src/startup-readiness.ts', async original => ({ ...await original<typeof import('../src/startup-readiness.ts')>(), isStartupReady: () => true }))
vi.mock('../src/thread-registry.ts', () => ({ assertLaunchSession: vi.fn(), registrationGeneration: vi.fn(() => 'generation'), withThreadLock: vi.fn(async (_session, fn) => fn()), markLaunchSessionClosed: vi.fn() }))
vi.mock('../src/launch-env.ts', () => ({ adapterStateDir: () => undefined, resolveLaunchEnv: () => ({ AU_MCP_SESSION: 'launch', AU_MCP_WORKSPACE: process.cwd() }) }))
import { finishSession } from '../src/bridge.ts'
import { completeSubagentTurn } from '../src/lift.ts'
import { createDaemonClient } from '@arsumbris/au-mcp-sdk'
beforeEach(() => { vi.clearAllMocks(); state.active = false; state.run = 0 })
afterEach(() => vi.restoreAllMocks())
it('two child turn endings retain one daemon run and never close the child session', async () => {
  const payload = { session_id: 'parent-thread', agent_id: 'child-thread', hook_event_name: 'SubagentStop', transcript_path: '/parent-rollout' }
  await completeSubagentTurn(payload)
  await completeSubagentTurn(payload)
  expect(state.run).toBe(1)
  expect(client.turnEnd).toHaveBeenCalledTimes(2)
  expect(client.turnEnd).toHaveBeenCalledWith('child-thread')
  expect(client.sessionClose).not.toHaveBeenCalled()
  expect(client.observe).not.toHaveBeenCalled()
})
it('SessionEnd sends final acknowledged tail and closes the existing raw thread without opening it', async () => {
  state.active = true; state.run = 1
  const events = [{ kind: 'assistant_message', data: { uuid: 'tail' }, at: '2026-09-05T12:00:00Z' }]
  expect(await finishSession({ session_id: 'thread', reason: 'exit' }, events, Date.now() + 2200)).toBe(1)
  expect(client.sessionOpen).not.toHaveBeenCalled()
  expect(client.observe).toHaveBeenCalledTimes(2)
  expect(client.observe.mock.calls[1]).toMatchObject(['thread', { kind: 'session_end', data: { reason: 'exit' } }])
  expect((client.sessionClose.mock.calls as unknown as Array<[string]>).map(call => call[0])).toEqual(['thread'])
  expect(createDaemonClient).toHaveBeenCalledWith(transport, { requestTimeoutMs: 350 })
  expect(state.run).toBe(1)
})
it('a failed final observation stops the prefix but still attempts end and close', async () => {
  client.observe.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('lost reply')).mockResolvedValueOnce(undefined)
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  const events = ['one', 'two', 'three'].map(uuid => ({ kind: 'assistant_message', data: { uuid } }))
  expect(await finishSession({ session_id: 'thread' }, events, Date.now() + 2200)).toBe(1)
  expect(client.observe).toHaveBeenCalledTimes(3)
  expect(client.sessionClose).toHaveBeenCalledWith('thread')
})
it('does not start additional RPCs after the finalization deadline', async () => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  expect(await finishSession({ session_id: 'thread' }, [{ kind: 'assistant_message', data: {} }], Date.now() - 1)).toBe(0)
  expect(client.observe).not.toHaveBeenCalled()
  expect(client.sessionClose).not.toHaveBeenCalled()
})
