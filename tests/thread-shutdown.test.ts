import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const daemon = vi.hoisted(() => ({ observe: vi.fn(async () => {}), sessionClose: vi.fn(async (_thread: string) => {}), dispose: vi.fn() }))
vi.mock('@arsumbris/au-mcp-sdk', async original => ({ ...await original<typeof import('@arsumbris/au-mcp-sdk')>(), connectSocket: async () => ({ close() {} }), createDaemonClient: () => daemon }))
import { openCodexSession } from '../src/session-open.ts'
import { codexAdapterInfo } from '../src/surface.ts'
import type { DaemonClient } from '@arsumbris/au-mcp-sdk'
import { finishSession } from '../src/bridge.ts'
import { registerLaunchSession, assertLaunchSession, closeOwnedProcessThreads, RUN_ID_ENV } from '../src/thread-registry.ts'
let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'au-shutdown-race-'))
  vi.stubEnv('CODEX_HOME', home); vi.stubEnv('AU_MCP_WORKSPACE', home); vi.stubEnv('AU_MCP_SESSION', 'launch'); vi.stubEnv(RUN_ID_ENV, 'process-a')
  vi.clearAllMocks(); daemon.sessionClose.mockImplementation(async () => {})
})
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }) })
it('ending one root preserves another root and children without proven termination', async () => {
  for (const thread of ['root-a', 'root-b', 'child-a', 'child-b']) await registerLaunchSession(thread, home, 'launch')
  await finishSession({ session_id: 'root-a' }, [], Date.now() + 2200)
  expect(daemon.sessionClose).toHaveBeenCalledExactlyOnceWith('root-a')
  expect(() => assertLaunchSession('root-a', home, 'launch')).toThrow('has closed')
  for (const thread of ['root-b', 'child-a', 'child-b']) expect(() => assertLaunchSession(thread, home, 'launch')).not.toThrow()
})
it('a child SessionEnd closes only the explicit child', async () => {
  for (const thread of ['root', 'child']) await registerLaunchSession(thread, home, 'launch')
  await finishSession({ session_id: 'root', agent_id: 'child' }, [], Date.now() + 2200)
  expect(daemon.sessionClose).toHaveBeenCalledExactlyOnceWith('child')
  expect(() => assertLaunchSession('root', home, 'launch')).not.toThrow()
})
it('serializes resumed registration after an acknowledged shutdown', async () => {
  await registerLaunchSession('thread', home, 'launch')
  let complete!: () => void
  daemon.sessionClose.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
  const ending = finishSession({ session_id: 'thread' }, [], Date.now() + 2200)
  await vi.waitFor(() => expect(daemon.sessionClose).toHaveBeenCalledOnce())
  let resumed = false
  const start = registerLaunchSession('thread', home, 'launch').then(() => { resumed = true })
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(resumed).toBe(false)
  complete(); await Promise.all([ending, start])
  expect(() => assertLaunchSession('thread', home, 'launch')).not.toThrow()
})
it('ignores a late ending hook from a superseded process incarnation', async () => {
  vi.stubEnv(RUN_ID_ENV, 'process-b'); await registerLaunchSession('thread', home, 'launch')
  vi.stubEnv(RUN_ID_ENV, 'process-a')
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  await finishSession({ session_id: 'thread' }, [], Date.now() + 2200)
  expect(daemon.sessionClose).not.toHaveBeenCalled()
  expect(() => assertLaunchSession('thread', home, 'launch')).not.toThrow()
})
it('does not deactivate registration when the daemon close reply is lost', async () => {
  await registerLaunchSession('thread', home, 'launch')
  daemon.sessionClose.mockRejectedValueOnce(new Error('lost reply'))
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  await finishSession({ session_id: 'thread' }, [], Date.now() + 2200)
  expect(() => assertLaunchSession('thread', home, 'launch')).not.toThrow()
})

it('process cleanup closes only records owned by the ended process', async () => {
  for (const thread of ['root', 'child']) await registerLaunchSession(thread, home, 'launch')
  vi.stubEnv(RUN_ID_ENV, 'process-b')
  await registerLaunchSession('resumed-elsewhere', home, 'launch')
  vi.stubEnv(RUN_ID_ENV, 'process-a')
  await closeOwnedProcessThreads(daemon.sessionClose, home, 'launch')
  expect(daemon.sessionClose.mock.calls.map(([thread]) => thread).sort()).toEqual(['child', 'root'])
  expect(() => assertLaunchSession('resumed-elsewhere', home, 'launch')).not.toThrow()
})

it('a queued daemon open rechecks membership after shutdown releases the lifecycle lock', async () => {
  await registerLaunchSession('thread', home, 'launch')
  let complete!: () => void
  daemon.sessionClose.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
  const ending = finishSession({ session_id: 'thread' }, [], Date.now() + 2200)
  await vi.waitFor(() => expect(daemon.sessionClose).toHaveBeenCalledOnce())
  const sessionOpen = vi.fn(async () => ({}))
  const opening = openCodexSession({ sessionOpen } as unknown as DaemonClient, codexAdapterInfo('thread', home), {
    handle: 'launch', stateDir: home, daemonIdentity: () => 'fixture-daemon',
  })
  const rejected = expect(opening).rejects.toThrow('has closed')
  complete()
  await ending
  await rejected
  expect(sessionOpen).not.toHaveBeenCalled()
})
