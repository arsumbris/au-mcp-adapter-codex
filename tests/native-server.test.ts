import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { prepareLaunch } from '../src/launch.ts'
import { startServer, connectServerSocket, rpc } from '../src/server.ts'
import { adapterStateDir } from '../src/launch-env.ts'
import { acquireFileLock } from '../src/file-lock.ts'
import { codexResumeRef } from '../src/resume-ref.ts'
import { startDaemon } from '@arsumbris/au-mcp'
import { createDaemonClient, connectSocket, socketPath } from '@arsumbris/au-mcp-sdk'
const binary = process.env.CODEX_TEST_BINARY
const roots: string[] = []
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'au-server-test-')); roots.push(root)
  const home = join(root, 'home'), workspace = join(root, 'workspace')
  mkdirSync(home); mkdirSync(workspace); vi.stubEnv('CODEX_HOME', home)
  return { root, home, workspace }
}
it('releases its process lease when Codex fails to start', async () => {
  const { workspace } = fixture()
  const launch = await prepareLaunch({ entry: workspace, binary: '/missing-codex', skills: [], inject: [] }, () => [])
  await expect(startServer(launch.env, '/missing-codex')).rejects.toThrow('did not start')
  const path = join(adapterStateDir(launch.env)!, 'leases', `${createHash('sha256').update(launch.session).digest('hex')}.lock`)
  const lock = acquireFileLock(path); expect(lock).toBeDefined(); lock!.release()
})
it.each(['skills', 'inject'] as const)('refuses to start when generated %s disappear after preparation', async kind => {
  const { root, workspace } = fixture()
  const source = join(root, 'generated'); mkdirSync(source)
  writeFileSync(join(source, 'content.md'), 'fixture instructions')
  const launch = await prepareLaunch({ entry: workspace, binary: process.execPath, skills: [], inject: [], [kind]: ['fixture'] },
    (_script, _profile, select) => select?.length ? [source] : [])
  rmSync(source, { recursive: true })
  await expect(startServer(launch.env, process.execPath)).rejects.toThrow('relaunch to regenerate')
})
it.skipIf(!binary)('enables AU for this launch without changing a saved disabled setting', async () => {
  const { home, workspace } = fixture()
  const config = `[features]
apps = false
plugins = false
[mcp_servers.au]
enabled = false
command = ${JSON.stringify(process.execPath)}
args = ["-e", "process.exit(1)"]
`
  writeFileSync(join(home, 'config.toml'), config)
  const daemon = await startDaemon({ workspace, plugins: [{
    manifest: { id: 'mcp.configuration_probe', name: 'configuration_probe', kind: 'tool', contractVersion: 0,
      inputSchema: { type: 'object', properties: {} } },
    invoke: async () => ({ content: 'configuration probe' }),
  }] })
  let server: Awaited<ReturnType<typeof startServer>> | undefined
  try {
    const launch = await prepareLaunch({ entry: workspace, binary: binary!, skills: [], inject: [] }, () => [])
    server = await startServer(launch.env, binary!)
    const status = await rpc(server.control, 'mcpServerStatus/list', {}) as {
      data: Array<{ name: string; tools: Record<string, unknown>; serverInfo: unknown }>
    }
    const adapter = status.data.find(item => item.name === 'au')
    expect(adapter?.serverInfo, server.stderr()).toMatchObject({ name: 'au' })
    expect(JSON.stringify(adapter?.tools), server.stderr()).toContain('configuration_probe')
    expect(server.env.CODEX_HOME).toBe(home)
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe(config)
  } finally { await server?.close(); await daemon.stop() }
}, 30000)
it.skipIf(!binary)('shares native history, preserves personal hooks, and guards resume selections', async () => {
  const { root, home, workspace } = fixture()
  const config = '[hooks]\nSessionStart = [{ hooks = [{ type = "command", command = "echo PERSONAL_HOOK_SENTINEL" }] }]\n[features]\napps = false\nplugins = false\n'
  writeFileSync(join(home, 'config.toml'), config)
  const launch = async (name: string) => prepareLaunch({ entry: workspace, binary: binary!, skills: [name], inject: [] }, (_script, _profile, select) => {
    if (select?.length === 0) return []
    const source = join(root, 'gen', name); mkdirSync(join(source, name), { recursive: true })
    writeFileSync(join(source, name, 'SKILL.md'), `---\nname: ${name}\ndescription: fixture ${name}\n---\n${name}`)
    return [source]
  })
  const a = await launch('alpha'), b = await launch('beta')
  const servers: Awaited<ReturnType<typeof startServer>>[] = []
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined
  try {
    const one = await startServer(a.env, binary!); servers.push(one)
    const two = await startServer(b.env, binary!); servers.push(two)
    await expect(startServer(a.env, binary!)).rejects.toThrow('already active')
    for (const [server, present, absent] of [[one, 'alpha', 'beta'], [two, 'beta', 'alpha']] as const) {
      expect(server.env.CODEX_HOME).toBe(home)
      const skills = JSON.stringify(await rpc(server.control, 'skills/list', { cwds: [workspace], forceReload: true }))
      expect(skills).toContain(`"name":"${present}"`); expect(skills).not.toContain(`"name":"${absent}"`)
      const hooks = JSON.stringify(await rpc(server.control, 'hooks/list', { cwds: [workspace] }))
      expect(hooks).toContain('PERSONAL_HOOK_SENTINEL'); expect(hooks).toContain('session-start.ts')
    }
    daemon = await startDaemon({ workspace, plugins: [] })
    const transport = await connectSocket(socketPath(workspace)); const kernel = createDaemonClient(transport)
    const thread = '11111111-2222-3333-4444-555555555555'
    try {
      await kernel.sessionOpen({ harness: 'mcp.adapter.codex', session: thread, workspace, nativeTools: [], resumeRef: codexResumeRef(thread, b.env) })
      await kernel.sessionClose(thread)
    } finally { kernel.dispose(); transport.close() }
    const client = await connectServerSocket(one.socketPath)
    try {
      await rpc(client, 'initialize', { clientInfo: { name: 'fixture', version: '1' }, capabilities: { experimentalApi: true } })
      client.send(JSON.stringify({ method: 'initialized' }))
      await expect(rpc(client, 'thread/resume', { threadId: thread })).rejects.toThrow('different capability selection')
      await expect(rpc(client, 'skills/extraRoots/set', { extraRoots: [] })).rejects.toThrow('fixed Arsumbris capability selection')
    } finally { client.close() }
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe(config)
  } finally { for (const server of servers.reverse()) await server.close(); await daemon?.stop() }
}, 40000)
