import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beginStartup, prepareStartupDelivery, markStartupContextEmitted, generatedStartupContext } from '../src/startup-readiness.ts'
import { adapterStateDir, INJECT_ENV } from '../src/launch-env.ts'
const homes: string[] = []
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'au-startup-state-')); homes.push(home); vi.stubEnv('AU_MCP_WORKSPACE', home)
  const identity = { workspace: home, session: 'thread', handle: 'launch' }
  beginStartup(identity, { source: 'startup' })
  return identity
}
afterEach(() => { vi.unstubAllEnvs(); homes.splice(0).forEach(home => rmSync(home, { recursive: true, force: true })) })
describe('startup context readiness', () => {
  it('serializes concurrent recovery so history is replayed only once', async () => {
    const identity = setup()
    beginStartup(identity, { source: 'resume' })
    let finish!: (value: boolean) => void
    const replay = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve }))
    const pending = prepareStartupDelivery(identity, async () => ['Instructions'], replay)
    await expect(prepareStartupDelivery(identity, async () => [], replay)).rejects.toThrow('already in progress')
    finish(true)
    await pending
    await prepareStartupDelivery(identity, async () => ['Instructions'], replay)
    expect(replay).toHaveBeenCalledTimes(1)
  })
  it('refuses missing startup state instead of losing the resumed history requirement', async () => {
    const identity = setup()
    beginStartup(identity, { source: 'resume', transcript_path: '/old-rollout' })
    rmSync(adapterStateDir()!, { recursive: true })
    const loader = vi.fn(async () => ['Instructions'])
    await expect(prepareStartupDelivery(identity, loader)).rejects.toThrow('startup checkpoint is missing')
    expect(loader).not.toHaveBeenCalled()
  })
  it('loads complete selected instructions and rejects missing generated files', () => {
    const identity = setup()
    const file = join(identity.workspace, 'content.md')
    const content = `START\n${'context '.repeat(15000)}\nEND`
    writeFileSync(file, content)
    vi.stubEnv(INJECT_ENV, JSON.stringify([file]))
    expect(generatedStartupContext()).toBe(content)
    rmSync(file)
    expect(() => generatedStartupContext()).toThrow('relaunch to regenerate')
    vi.stubEnv(INJECT_ENV, '[]')
    expect(generatedStartupContext()).toBe('')
  })
  it('rehydrates history again when the daemon is replaced, including a running non-resumed thread', async () => {
    const identity = setup()
    beginStartup(identity, { source: 'startup', transcript_path: '/current-rollout' })
    const replay = vi.fn(async () => true)
    const first = await prepareStartupDelivery(identity, async () => ['Initial'], replay, undefined, 'daemon-a')
    markStartupContextEmitted(first)
    expect(replay).not.toHaveBeenCalled()
    const loader = vi.fn(async () => ['Recovered'])
    replay.mockResolvedValueOnce(false)
    await expect(prepareStartupDelivery(identity, loader, replay, undefined, 'daemon-b')).rejects.toThrow('history')
    expect(loader).not.toHaveBeenCalled()
    const next = await prepareStartupDelivery(identity, loader, replay, undefined, 'daemon-b')
    expect(replay).toHaveBeenCalledTimes(2)
    expect(replay).toHaveBeenLastCalledWith(expect.objectContaining({ transcript_path: '/current-rollout', source: 'startup' }))
    markStartupContextEmitted(next)
    expect((await prepareStartupDelivery(identity, loader, replay, undefined, 'daemon-b')).required).toBe(false)
  })
  it('retains pending context after an unavailable daemon and only becomes ready after explicit delivery', async () => {
    const identity = setup()
    await expect(prepareStartupDelivery(identity, async () => { throw new Error('offline') })).rejects.toThrow('offline')
    const loader = vi.fn(async () => ['Recovered instructions'])
    const delivery = await prepareStartupDelivery(identity, loader)
    expect(delivery).toMatchObject({ context: 'Recovered instructions', required: true })
    expect((await prepareStartupDelivery(identity, loader)).required).toBe(true)
    markStartupContextEmitted(delivery)
    expect((await prepareStartupDelivery(identity, loader)).required).toBe(false)
    expect(loader).toHaveBeenCalledTimes(2)
  })
  it('requires resumed history to be acknowledged before loading context', async () => {
    const identity = setup()
    beginStartup(identity, { source: 'resume', transcript_path: '/old-rollout' })
    const loader = vi.fn(async () => ['Resume notice'])
    await expect(prepareStartupDelivery(identity, loader, async () => false)).rejects.toThrow('resumed history')
    expect(loader).not.toHaveBeenCalled()
    const replay = vi.fn(async () => true)
    const delivery = await prepareStartupDelivery(identity, loader, replay)
    expect(replay).toHaveBeenCalledWith(expect.objectContaining({ transcript_path: '/old-rollout', source: 'resume' }))
    expect(delivery.required).toBe(true)
  })
  it('does not let a stale prior-run response mark a resumed run ready', async () => {
    const identity = setup()
    const old = await prepareStartupDelivery(identity, async () => ['Old notice'])
    beginStartup(identity, { source: 'resume' })
    expect(() => markStartupContextEmitted(old)).toThrow('run changed')
  })
  it('requires new computed instructions when the daemon is replaced', async () => {
    const identity = setup()
    const old = await prepareStartupDelivery(identity, async () => ['Old daemon notice'], undefined, undefined, 'daemon-a')
    markStartupContextEmitted(old)
    const next = await prepareStartupDelivery(identity, async () => ['New daemon notice'], async () => true, undefined, 'daemon-b')
    expect(next).toMatchObject({ context: 'New daemon notice', required: true })
    expect(() => markStartupContextEmitted(old)).toThrow('run changed')
  })
})
