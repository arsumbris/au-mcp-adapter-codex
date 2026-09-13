// Real Codex with a local fake Responses server; no credentials, external model, or paid calls.
import { it, expect, vi } from 'vitest'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startDaemon } from '@arsumbris/au-mcp'
import { EventKind, type SessionEvent } from '@arsumbris/au-mcp-sdk'
import { prepareLaunch } from '../src/launch.ts'
import { spawnFixture } from './fixture-exec.ts'
import { extractToolFailed } from '../src/failed-tools.ts'

const binary = process.env.CODEX_TEST_BINARY
it.skipIf(!binary)('real Codex native shell failure has an authoritative capture representation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'au-native-failure-'))
  vi.stubEnv('CODEX_HOME', join(root, 'home'))
  const workspace = join(root, 'workspace')
  mkdirSync(join(workspace, '.arsumbris'), { recursive: true })
  const seen: SessionEvent[] = []
  const daemon = await startDaemon({ workspace, plugins: [{ manifest: { id: 'mcp.recorder', name: 'recorder', kind: 'hook', shapes: ['observer'], contractVersion: 0 }, onEvent: event => { seen.push(event) } }] })
  const requests: unknown[] = []
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || !request.url?.endsWith('/responses')) { response.writeHead(404).end(); return }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    const id = `response-${requests.length}`
    const item = requests.length === 1
      ? { type: 'function_call', call_id: 'fixture-native-fail-1', namespace: 'functions', name: 'exec_command', arguments: JSON.stringify({ cmd: 'exit 7', max_output_tokens: 100 }) }
      : { type: 'message', role: 'assistant', id: 'fixture-message', content: [{ type: 'output_text', text: 'LOCAL_FIXTURE_DONE' }] }
    const events = [{ type: 'response.created', response: { id } }, { type: 'response.output_item.done', item }, { type: 'response.completed', response: { id, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } }]
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  let child: ReturnType<typeof spawn> | undefined
  try {
    const launch = await prepareLaunch({ entry: workspace, binary: binary!, skills: [], inject: [] }, () => [])
    const overrides = {
      model: 'gpt-5.4', model_provider: 'fixture', 'model_providers.fixture.name': 'Local fixture',
      'model_providers.fixture.base_url': `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
      'model_providers.fixture.wire_api': 'responses', 'model_providers.fixture.requires_openai_auth': false,
      'features.enable_request_compression': false, 'features.apps': false, 'features.plugins': false, 'analytics.enabled': false,
    }
    const argv = ['exec', '--skip-git-repo-check', '--dangerously-bypass-hook-trust', '--json', '--cd', workspace, ...Object.entries(overrides).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]), 'Run the harmless fixture command exit 7 and finish.']
    child = spawnFixture(launch, argv)
    let stdout = ''; let stderr = ''
    child.stdout!.on('data', chunk => { stdout += String(chunk) })
    child.stderr!.on('data', chunk => { stderr += String(chunk) })
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { child!.kill('SIGKILL'); reject(new Error(`Native fixture timeout\n${stdout}\n${stderr}`)) }, 45_000)
      child!.once('error', error => { clearTimeout(timer); reject(error) })
      child!.once('exit', code => { clearTimeout(timer); resolve(code) })
    })
    expect(code, stderr + stdout).toBe(0)
    const files = readdirSync(launch.env.CODEX_HOME!, { recursive: true, encoding: 'utf8' }).filter(path => path.endsWith('.jsonl'))
    const text = files.map(path => readFileSync(join(launch.env.CODEX_HOME!, path), 'utf8')).join('\n')
    const failures = extractToolFailed(text).events
    expect(failures).toHaveLength(1)
    expect(failures[0]!.data).toMatchObject({ tool: 'Bash', tool_use_id: 'fixture-native-fail-1', exit_code: 7 })
    const observed = seen.filter(event => event.kind === EventKind.ToolFailed)
    expect(observed).toHaveLength(1)
    expect(observed[0]!.data).toMatchObject({ tool: 'Bash', tool_use_id: 'fixture-native-fail-1', exit_code: 7 })
    expect(JSON.stringify(requests.at(-1)), stderr + stdout).toContain('Process exited with code 7')
  } finally {
    child?.kill('SIGKILL')
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    await daemon.stop()
    vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true })
  }
}, 60_000)
