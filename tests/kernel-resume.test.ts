import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { startDaemon } from '@arsumbris/au-mcp'
import { createDaemonClient, connectSocket, socketPath } from '@arsumbris/au-mcp-sdk'
import { prepareLaunch } from '../src/launch.ts'
import { codexAdapterInfo } from '../src/surface.ts'
import { codexResumeRef, parseResumeRef } from '../src/resume-ref.ts'
afterEach(() => vi.unstubAllEnvs())
it('kernel records restore native threads and selections without generated-directory dependencies', async () => {
  const root = mkdtempSync(join(tmpdir(), 'au-kernel-resume-'))
  const workspace = join(root, 'workspace'); mkdirSync(workspace)
  vi.stubEnv('CODEX_HOME', join(root, 'native'))
  const daemon = await startDaemon({ workspace, plugins: [] })
  const transport = await connectSocket(socketPath(workspace)); const client = createDaemonClient(transport)
  try {
    const first = await prepareLaunch({ entry: workspace, binary: process.execPath, skills: [], inject: [] }, () => [])
    const thread = randomUUID()
    const info = { ...codexAdapterInfo(thread, workspace), resumeRef: codexResumeRef(thread, first.env)! }
    await client.sessionOpen(info); await client.sessionClose(thread)
    const record = (await client.listDormant()).find(s => s.id === thread)!
    expect(parseResumeRef(record.resumeRef!).selections).toEqual({ skills: [], inject: [] })
    const generate = vi.fn(() => [])
    const resumed = await prepareLaunch({ entry: workspace, binary: process.execPath, resume: thread }, generate)
    expect(generate).toHaveBeenCalledTimes(2)
    expect(resumed.env.CODEX_HOME).toBe(first.env.CODEX_HOME)
    expect(resumed.harnessArgv).toEqual(['resume', thread, '--cd', workspace])
    await client.sessionOpen({ ...info, resume: true }); await client.sessionClose(thread)
    const again = (await client.listDormant()).find(s => s.id === thread)!
    expect(again.resumeRef).toBe(record.resumeRef); expect(again.run).toBeGreaterThan(record.run)
    await expect(prepareLaunch({ entry: workspace, binary: process.execPath, resume: randomUUID() }, generate)).rejects.toThrow('No AU launch selection')
  } finally { client.dispose(); transport.close(); await daemon.stop(); rmSync(root, { recursive: true, force: true }) }
})
