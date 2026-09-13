import { adapterStateDir } from '../src/launch-env.ts'
// Profile permissions through a spawned MCP server, real daemon and wire-level engine fixture.
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { startDaemon, type RunningDaemon } from '@arsumbris/au-mcp'
import type { Plugin } from '@arsumbris/au-mcp-sdk'

import { profileEngine } from './profile-engine.ts'
const engines = new Map<string, Awaited<ReturnType<typeof profileEngine>>>()
const directories: string[] = []

const THREAD = '00000000-0000-4000-8000-000000000001'
const META = { 'x-codex-turn-metadata': { thread_id: THREAD } }
const BIN = resolve(fileURLToPath(new URL('../bin/mcp-server.ts', import.meta.url)))

const tool = (name: string, guidance?: string): Plugin => ({
  manifest: { id: `mcp.${name}`, name, contractVersion: 0, kind: 'tool', ...(guidance ? { guidance } : {}) },
  invoke: async (input) => ({ content: input }),
})

async function tempWorkspace(): Promise<string> {
  const ws = await mkdtemp(join(tmpdir(), 'au-tools-e2e-'))
  await mkdir(join(ws, '.arsumbris'), { recursive: true })
  directories.push(ws)
  engines.set(ws, await profileEngine(ws))
  return ws
}

/** Each selection becomes an authored profile row in the engine fixture. */
async function connectShim(workspace: string, auTools?: string): Promise<Client> {
  const home = await mkdtemp(join(tmpdir(), 'au-codex-shim-'))
  directories.push(home)
  const profile = auTools === undefined ? undefined : `selection-${Date.now()}-${Math.random()}`
  if (profile) engines.get(workspace)!.add(profile, auTools!.split(',').map(s => s.trim()).filter(Boolean))
  const handle = 'allowlist-test-launch'
  const registry = join(adapterStateDir({ AU_MCP_WORKSPACE: workspace })!, 'threads')
  await mkdir(registry, { recursive: true })
  await writeFile(join(registry, `${createHash('sha256').update(THREAD).digest('hex')}.json`), JSON.stringify({ session: THREAD, workspace, handle }))
  const startup = join(adapterStateDir({ AU_MCP_WORKSPACE: workspace })!, 'startup')
  await mkdir(startup, { recursive: true })
  await writeFile(join(startup, `${createHash('sha256').update(THREAD).digest('hex')}.json`), JSON.stringify({
    version: 1, session: THREAD, workspace, handle, generation: randomUUID(), status: 'pending', replayPending: false,
    payload: { session_id: THREAD, cwd: workspace, source: 'startup' },
  }))
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !key.startsWith('AU_MCP_'))) as Record<string, string>
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--experimental-strip-types', BIN],
    env: {
      ...inherited,
      CODEX_HOME: home,
      AU_MCP_SESSION: handle,
      AU_MCP_WORKSPACE: workspace,
      ...(auTools === undefined ? {} : { AU_MCP_PROFILE: profile! }),
    },
  })
  const client = new Client({ name: 'allowlist-test', version: '0' })
  await client.connect(transport)
  return client
}

describe('profile tool visibility through a spawned mcp-server process', () => {
  const running: RunningDaemon[] = []
  const clients: Client[] = []

  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {})
    for (const d of running.splice(0)) await d.stop()
    for (const engine of engines.values()) await engine.close()
    engines.clear()
    for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
  })

  async function daemonWith(...names: string[]): Promise<string> {
    const ws = await tempWorkspace()
    running.push(await startDaemon({ workspace: ws, plugins: names.map((n) => tool(n)) }))
    return ws
  }

  async function advertised(workspace: string, auTools?: string): Promise<string[]> {
    const client = await connectShim(workspace, auTools)
    clients.push(client)
    const { tools } = await client.listTools()
    return tools.map((t) => t.name).sort()
  }

  it('fails initial MCP startup when the daemon is unavailable instead of caching a false empty catalogue', async () => {
    const workspace = await tempWorkspace()
    await expect(connectShim(workspace)).rejects.toThrow()
  })

  it('advertises exactly the named tools', async () => {
    const ws = await daemonWith('shout', 'read_file', 'au_typed')
    expect(await advertised(ws, 'read_file,au_typed')).toEqual(['au_typed', 'read_file'])
  })

  it('advertises every tool when no profile is selected', async () => {
    const ws = await daemonWith('shout', 'read_file')
    expect(await advertised(ws, undefined)).toEqual(['read_file', 'shout'])
  })

  it('advertises no tool when the profile has an empty tools list', async () => {
    const ws = await daemonWith('shout', 'read_file')
    expect(await advertised(ws, '')).toEqual([])
  })

  it('tolerates surrounding whitespace and trailing separators', async () => {
    const ws = await daemonWith('shout', 'read_file')
    expect(await advertised(ws, ' read_file , shout , ')).toEqual(['read_file', 'shout'])
  })

  it('gives two concurrent shims on ONE daemon different tool sets', async () => {
    const ws = await daemonWith('shout', 'read_file')
    const [restricted, full] = await Promise.all([advertised(ws, 'read_file'), advertised(ws, undefined)])
    expect(restricted).toEqual(['read_file'])
    expect(full).toEqual(['read_file', 'shout'])
  })

  it('keeps shared context out of MCP server instructions', async () => {
    const ws = await daemonWith('shout', 'read_file', 'au_typed')
    const client = await connectShim(ws, 'read_file,au_typed')
    clients.push(client)

    const instructions = client.getInstructions() ?? ''
    expect(instructions).toBe('')
  })

  it('carries a tool guidance note only when that tool is in the session', async () => {
    const ws = await tempWorkspace()
    running.push(
      await startDaemon({
        workspace: ws,
        plugins: [tool('au_type_system', 'Learn the type system here before authoring type-defs.'), tool('read_file')],
      }),
    )

    const withIt = await connectShim(ws, 'au_type_system,read_file')
    clients.push(withIt)
    const { tools } = await withIt.listTools()
    expect(tools.find(tool => tool.name === 'au_type_system')?.description).toContain('before authoring type-defs')
    expect(tools.find(tool => tool.name === 'read_file')?.description).not.toContain('before authoring type-defs')
    expect(withIt.getInstructions() ?? '').toBe('')

    const without = await connectShim(ws, 'read_file')
    clients.push(without)
    const text = JSON.stringify(await without.listTools())
    expect(text).not.toContain('before authoring type-defs')
    expect(text).not.toContain('au_type_system')
  })

  it('calls an advertised tool, and refuses one outside the allowlist', async () => {
    const ws = await daemonWith('shout', 'read_file')
    const client = await connectShim(ws, 'read_file')
    clients.push(client)

    const startup = await client.callTool({ name: 'read_file', arguments: { a: 1 }, _meta: META })
    expect(startup.isError).toBe(true)
    expect(JSON.stringify(startup.content)).toContain('This tool did not run')
    expect(JSON.stringify(startup.content)).toContain('The 1 tools available')
    expect(JSON.stringify(startup.content)).not.toContain('shout')

    const ok = await client.callTool({ name: 'read_file', arguments: { a: 1 }, _meta: META })
    expect(ok.isError).toBeFalsy()
    expect(JSON.stringify(ok.content)).not.toContain('startup instructions')

    // `shout` is loaded in the daemon but was never advertised to THIS shim.
    const refused = await client.callTool({ name: 'shout', arguments: {}, _meta: META })
    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused.content)).toContain('not available in this session')
  })
})
