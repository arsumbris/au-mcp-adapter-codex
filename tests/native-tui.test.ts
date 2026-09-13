import { it, expect, vi } from 'vitest'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { realpathSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startDaemon } from '@arsumbris/au-mcp'
import { EventKind, type SessionEvent } from '@arsumbris/au-mcp-sdk'
import { prepareLaunch } from '../src/launch.ts'
import { adapterStateDir } from '../src/launch-env.ts'
import { codexResumeRef } from '../src/resume-ref.ts'
import { startServer, rpc } from '../src/server.ts'

const binary = process.env.CODEX_TEST_BINARY
it.skipIf(!binary)('native TUI invokes AU tools and receives context across fork and explicit resume in shared history', async () => {
  const root = mkdtempSync(join(tmpdir(), 'au-native-tui-'))
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  mkdirSync(home)
  mkdirSync(join(workspace, '.arsumbris'), { recursive: true })
  vi.stubEnv('CODEX_HOME', home)
  const requests = new Map<string, Record<string, unknown>[]>()
  const errors: string[] = []
  const model = createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/responses')) { res.writeHead(404).end(); return }
    try {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
      const thread = String((body.client_metadata as Record<string, unknown>)?.thread_id)
      const captured = requests.get(thread) ?? []
      captured.push(body)
      requests.set(thread, captured)
      const id = `fixture-${thread}-${captured.length}`
      const item = captured.length === 1
        ? { type: 'tool_search_call', call_id: `search-${thread}`, execution: 'client', arguments: { query: 'fixture_probe', limit: 1 } }
        : captured.length === 2
          ? { type: 'function_call', call_id: `call-${thread}`, namespace: 'mcp__au', name: 'fixture_probe', arguments: '{}' }
          : { type: 'message', role: 'assistant', id, content: [{ type: 'output_text', text: 'LOCAL_NATIVE_TUI_OK' }] }
      const events = [
        { type: 'response.created', response: { id } },
        { type: 'response.output_item.done', item },
        { type: 'response.completed', response: { id, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } },
      ]
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''))
    } catch (error) { errors.push(String(error)); res.writeHead(500).end() }
  })
  await new Promise<void>(r => model.listen(0, '127.0.0.1', r))
  const port = (model.address() as { port: number }).port
  // Only our authored disposable fixture is trusted; native user configuration is untouched.
  writeFileSync(join(home, 'config.toml'), `model="gpt-5.6-terra"
model_provider="fixture"
[model_providers.fixture]
name="Local fixture"
base_url="http://127.0.0.1:${port}/v1"
wire_api="responses"
requires_openai_auth=false
[features]
apps=false
plugins=false
enable_request_compression=false
[analytics]
enabled=false
[projects.${JSON.stringify(workspace)}]
trust_level="trusted"
[projects.${JSON.stringify(realpathSync(workspace))}]
trust_level="trusted"
`)
  const calls: Array<string | undefined> = []
  const seen: SessionEvent[] = []
  const daemon = await startDaemon({ workspace, approval: async () => 'granted', plugins: [
    { manifest: { id: 'mcp.fixture_probe', name: 'fixture_probe', contractVersion: 0, kind: 'tool', description: 'Read-only fixture probe', inputSchema: { type: 'object', properties: {} } },
      invoke: async (_input, context) => { calls.push(context?.session); return { content: { marker: 'NATIVE_AU_TOOL_OK' } } } },
    { manifest: { id: 'mcp.fixture_recorder', name: 'fixture_recorder', contractVersion: 0, kind: 'hook', shapes: ['observer'] }, onEvent: event => { seen.push(event) } },
  ] })
  let server: Awaited<ReturnType<typeof startServer>> | undefined
  try {
    const launch = await prepareLaunch({ entry: workspace, binary: binary!, skills: [], inject: ['fixture'] }, (_script, _profile, select) => {
      if (select?.length === 0) return []
      const generationHome = join(root, 'generated')
      const source = join(generationHome, 'inject')
      mkdirSync(source, { recursive: true })
      writeFileSync(join(source, 'content.md'), 'NATIVE_COACH_CONTEXT_SENTINEL: Use the fixture probe for this test.')
      return [source]
    })
    server = await startServer(launch.env, binary!, ['-c', 'mcp_servers.au.default_tools_approval_mode="approve"'])
    const output = join(root, 'tui.txt')
    const child = spawn('python3', [join(import.meta.dirname, 'native-tui-driver.py'), binary!, server.endpoint, workspace, output], { env: { ...server.env, FIXTURE_STATE_DIR: adapterStateDir(server.env) }, stdio: ['ignore', 'pipe', 'pipe'] })
    let diagnostic = ''
    child.stdout.on('data', b => diagnostic += String(b))
    child.stderr.on('data', b => diagnostic += String(b))
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
    const screen = readFileSync(output, 'utf8')
    const detail = diagnostic + screen + server.stderr()
    expect(code, detail).toBe(0)
    const { root: original } = JSON.parse(diagnostic.trim()) as { root: string }
    expect(requests.get(original)?.length, detail).toBeGreaterThanOrEqual(4)
    expect(calls, detail).toHaveLength(2)
    expect(new Set(calls).size, detail).toBe(2)
    for (const thread of calls) {
      expect(JSON.stringify(requests.get(thread!)?.[0])).toContain('NATIVE_COACH_CONTEXT_SENTINEL')
      expect(JSON.stringify(requests.get(thread!)?.at(-1))).toContain('NATIVE_AU_TOOL_OK')
      expect(seen.some(event => event.session === thread && event.kind === EventKind.SessionStart)).toBe(true)
    }
    expect(errors).toEqual([])
    expect(screen).not.toContain('Hook failed')
    const threads = readdirSync(join(adapterStateDir(launch.env)!, 'threads')).filter(f => f.endsWith('.json'))
    expect(threads.length, detail).toBeGreaterThanOrEqual(2)
    expect(readdirSync(home)).toContain('sessions')
    const list = await rpc(server.control, 'thread/list', { limit: 100, modelProviders: [] })
    for (const thread of calls) expect(JSON.stringify(list)).toContain(thread)
    const resumeRef = codexResumeRef(original, launch.env)!
    const beforeReconnect = requests.get(original)!.length
    // A fresh native TUI can reconnect to the prepared live server. Then repeat
    // after a complete server stop/restart, as the managed launcher does.
    for (const restart of [false, true]) {
      if (restart) {
        await server.close()
        for (const filename of threads) {
          const registration = JSON.parse(readFileSync(join(adapterStateDir(launch.env)!, 'threads', filename), 'utf8'))
          expect(registration.active, server.stderr()).toBe(false)
        }
      }
      const resumed = restart ? await prepareLaunch({ entry: workspace, binary: binary!, resume: resumeRef }, (_script, _profile, select) => select?.length === 0 ? [] : [join(root, 'generated', 'inject')]) : launch
      const reconnectOutput = join(root, `reconnect-${restart}.txt`)
      const tui = spawn('python3', [join(import.meta.dirname, 'native-tui-driver.py'), binary!, restart ? 'managed' : server.endpoint, workspace, reconnectOutput, original], { env: { ...server.env, ...resumed.env, FIXTURE_NODE_BINARY: process.execPath, FIXTURE_STATE_DIR: adapterStateDir(resumed.env) }, stdio: ['ignore', 'pipe', 'pipe'] })
      let reconnectDiagnostic = ''
      tui.stdout.on('data', b => reconnectDiagnostic += String(b))
      tui.stderr.on('data', b => reconnectDiagnostic += String(b))
      const exit = await new Promise<number | null>((resolve, reject) => { tui.once('error', reject); tui.once('exit', resolve) })
      expect(exit, reconnectDiagnostic + readFileSync(reconnectOutput, 'utf8') + server.stderr()).toBe(0)
    }
    expect(requests.get(original)!.length).toBeGreaterThanOrEqual(beforeReconnect + 2)
    expect(calls).toHaveLength(2) // Neither resume replays an old tool invocation.

  } finally {
    await server?.close()
    await daemon.stop()
    await new Promise<void>(r => model.close(() => r()))
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  }
}, 100000)
