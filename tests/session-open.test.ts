import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { DaemonClient } from '@arsumbris/au-mcp-sdk'
import { openCodexSession } from '../src/session-open.ts'
import { codexAdapterInfo } from '../src/surface.ts'
const directories: string[] = []
function fixture() {
  const stateDir = mkdtempSync(join(tmpdir(), 'au-session-open-')); directories.push(stateDir)
  const info = codexAdapterInfo('thread', '/vault')
  const open = vi.fn(async () => ({ contractVersion: 0 }))
  const client = { sessionOpen: open } as unknown as DaemonClient
  return { stateDir, info, open, client }
}
afterEach(() => { directories.splice(0).forEach(stateDir => rmSync(stateDir, { recursive: true, force: true })) })
describe('serialized initialized-session stand-in', () => {
  it('does not send a duplicate open while the initial session is still initializing', async () => {
    const { stateDir, info, open, client } = fixture()
    let finish!: () => void
    open.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ contractVersion: 0 }) }))
    const options = { stateDir, daemonIdentity: () => 'daemon-a' }
    const first = openCodexSession(client, info, options)
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce())
    const second = openCodexSession(client, info, options)
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(open).toHaveBeenCalledOnce()
    finish(); await Promise.all([first, second])
    expect(open).toHaveBeenCalledTimes(2)
  })
  it('taints a lost opening reply until the daemon socket changes', async () => {
    const { stateDir, info, open, client } = fixture()
    open.mockRejectedValueOnce(new Error('connection lost'))
    await expect(openCodexSession(client, info, { stateDir, daemonIdentity: () => 'a' })).rejects.toThrow('connection lost')
    await expect(openCodexSession(client, info, { stateDir, daemonIdentity: () => 'a' })).rejects.toThrow('previous session-open')
    expect(open).toHaveBeenCalledOnce()
    await openCodexSession(client, info, { stateDir, daemonIdentity: () => 'b' })
    expect(open).toHaveBeenCalledTimes(2)
  })
  it('does not taint a preflight failure before session-open was sent', async () => {
    const { stateDir, info, open, client } = fixture()
    info.profile = 'profile'
    const check = vi.fn(async () => { throw new Error('profile not found') })
    await expect(openCodexSession(client, info, { stateDir, daemonIdentity: () => 'a', verifyProfile: check })).rejects.toThrow('profile not found')
    expect(open).not.toHaveBeenCalled()
    await openCodexSession(client, info, { stateDir, daemonIdentity: () => 'a', verifyProfile: async () => {} })
    expect(open).toHaveBeenCalledOnce()
  })
})
