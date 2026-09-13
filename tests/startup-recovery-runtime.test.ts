// Real Codex, local Responses fixture, no model account. The daemon appears only after
// SessionStart failed, proving startup instructions are recovered before a later tool runs.
import { it, expect, vi } from 'vitest'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startDaemon, type RunningDaemon } from '@arsumbris/au-mcp'
import { EventKind, type Plugin, type SessionEvent } from '@arsumbris/au-mcp-sdk'
import { prepareLaunch } from '../src/launch.ts'
import { spawnFixture } from './fixture-exec.ts'
import { codexResumeRef } from '../src/resume-ref.ts'

const binary = process.env.CODEX_TEST_BINARY
it.skipIf(!binary)('recovers missed startup context before admitting work when the daemon starts late', async () => {
  const root = mkdtempSync(join(tmpdir(), 'au-startup-recovery-'))
  vi.stubEnv('CODEX_HOME', join(root, 'home'))
  const workspace = join(root, 'workspace'); mkdirSync(join(workspace, '.arsumbris'), { recursive: true })
  const requests: unknown[] = []
  const seen: SessionEvent[] = []
  let running: RunningDaemon | undefined
  let invocations = 0
  let contextSeenBeforeInvoke = false
  let resuming = false
  let resumeRequests = 0
  let mcpInvocations = 0
  let mcpSession: string | undefined
  const plugins: Plugin[] = [
    { manifest: { id: 'mcp.recorder', name: 'recorder', kind: 'hook', shapes: ['observer'], contractVersion: 0 }, onEvent: event => {
      seen.push(event)
      if (event.kind === EventKind.ToolStart && (event.data as { tool_use_id?: string }).tool_use_id === 'recovery-probe') {
        invocations++; contextSeenBeforeInvoke = requests.some(request => JSON.stringify(request).includes('COMPUTED_STARTUP_RECOVERED_SENTINEL') && JSON.stringify(request).includes('STATIC_STARTUP_RECOVERED_SENTINEL'))
      }
    } },
    { manifest: { id: 'mcp.fixture_probe', name: 'fixture_probe', kind: 'tool', contractVersion: 0, description: 'Read-only resumed recovery probe', inputSchema: { type: 'object', properties: {} } }, invoke: async (_input, context) => { mcpInvocations++; mcpSession = context?.session; return { content: { marker: 'RESUMED_MCP_PROBE_OK' } } } },
    { manifest: { id: 'mcp.starter', name: 'starter', kind: 'hook', shapes: ['session-start'], contractVersion: 0 }, onSessionStart: () => ({ inject: ['COMPUTED_STARTUP_RECOVERED_SENTINEL'] }) },
  ]

  const errors: string[] = []
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || !request.url?.endsWith('/responses')) { response.writeHead(404).end(); return }
    try {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      if (requests.length === 1) running = await startDaemon({ workspace, plugins })
      if (resuming) resumeRequests++
      const item = resuming
        ? resumeRequests === 1 ? { type: 'tool_search_call', call_id: 'resume-search', execution: 'client', arguments: { query: 'fixture_probe', limit: 1 } }
          : resumeRequests === 2 ? { type: 'function_call', call_id: 'resume-probe', namespace: 'mcp__au', name: 'fixture_probe', arguments: '{}' }
          : { type: 'message', role: 'assistant', id: 'resume-recovery-done', content: [{ type: 'output_text', text: 'RESUME_RECOVERY_DONE' }] }
        : requests.length === 1
        ? { type: 'function_call', call_id: 'recovery-barrier', namespace: 'functions', name: 'exec_command', arguments: JSON.stringify({ cmd: 'printf SHOULD_NOT_RUN', max_output_tokens: 100 }) }
        : requests.length === 2 ? { type: 'function_call', call_id: 'recovery-probe', namespace: 'functions', name: 'exec_command', arguments: JSON.stringify({ cmd: 'printf RECOVERED_PROBE_OK', max_output_tokens: 100 }) }
        : { type: 'message', role: 'assistant', id: 'recovery-done', content: [{ type: 'output_text', text: 'RECOVERY_FIXTURE_DONE' }] }
      const id = `response-${requests.length}`
      const events = [{ type: 'response.created', response: { id } }, { type: 'response.output_item.done', item }, { type: 'response.completed', response: { id, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } }]
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
    } catch (error) { errors.push(String(error)); response.writeHead(500).end() }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  let child: ReturnType<typeof spawn> | undefined
  try {
    const launch = await prepareLaunch({ entry: workspace, binary: binary!, skills: [], inject: ['fixture'] }, (_script, _profile, select) => {
      if (select?.length === 0) return []
      const generationHome = join(root, 'generated')
      const source = join(generationHome, 'inject'); mkdirSync(source, { recursive: true }); writeFileSync(join(source, 'content.md'), 'STATIC_STARTUP_RECOVERED_SENTINEL'); return [source]
    })
    const overrides = {
      model: 'gpt-5.4', model_provider: 'fixture', 'model_providers.fixture.name': 'Local fixture',
      'model_providers.fixture.base_url': `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
      'model_providers.fixture.wire_api': 'responses', 'model_providers.fixture.requires_openai_auth': false,
      'features.enable_request_compression': false, 'features.apps': false, 'features.plugins': false, 'analytics.enabled': false,
      'mcp_servers.au.default_tools_approval_mode': 'approve',
    }
    const argv = ['exec', '--skip-git-repo-check', '--dangerously-bypass-hook-trust', '--json', '--cd', workspace, ...Object.entries(overrides).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]), 'Exercise the harmless local recovery fixture, then finish.']
    child = spawnFixture(launch, argv)
    let stdout = ''; let stderr = ''; child.stdout!.on('data', chunk => { stdout += String(chunk) }); child.stderr!.on('data', chunk => { stderr += String(chunk) })
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { child!.kill('SIGKILL'); reject(new Error(`Recovery fixture timeout\n${stdout}\n${stderr}`)) }, 45_000)
      child!.once('error', error => { clearTimeout(timer); reject(error) }); child!.once('exit', code => { clearTimeout(timer); resolve(code) })
    })
    expect({ code, errors }, stderr + stdout).toEqual({ code: 0, errors: [] })
    expect(JSON.stringify(requests[0])).not.toContain('COMPUTED_STARTUP_RECOVERED_SENTINEL')
    expect(JSON.stringify(requests[1]), stderr + stdout).toContain('COMPUTED_STARTUP_RECOVERED_SENTINEL')
    expect(JSON.stringify(requests[1]), stderr + stdout).toContain('STATIC_STARTUP_RECOVERED_SENTINEL')
    expect(seen.some(event => event.kind === EventKind.ToolStart && (event.data as { tool_use_id?: string }).tool_use_id === 'recovery-barrier')).toBe(false)
    expect(invocations, stderr + stdout).toBe(1)
    expect(seen.some(event => event.kind === EventKind.ToolCall && (event.data as { tool_use_id?: string }).tool_use_id === 'recovery-probe' && JSON.stringify(event.data).includes('RECOVERED_PROBE_OK'))).toBe(true)
    expect(contextSeenBeforeInvoke).toBe(true)
    expect(JSON.stringify(requests.at(-1))).toContain('RECOVERED_PROBE_OK')
    // Codex 0.153.2 logs tools/list_changed without refreshing its catalogue. A new
    // connection on resume must discover the daemon's actual tools, rather than relying
    // on an invented within-turn notification refresh.
    const started = stdout.split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>).find(event => event.type === 'thread.started')
    const thread = String(started?.thread_id)
    const resumed = await prepareLaunch({ entry: workspace, binary: binary!, resume: codexResumeRef(thread, launch.env)! }, (_script, _profile, select) => select?.length === 0 ? [] : [join(root, 'generated', 'inject')])
    resuming = true
    const resumeArgv = ['exec', '--cd', workspace, 'resume', '--skip-git-repo-check', '--dangerously-bypass-hook-trust', '--json', ...Object.entries(overrides).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]), thread, 'Run the now-available MCP recovery probe and finish.']
    child = spawnFixture(resumed, resumeArgv)
    let resumeStdout = ''; let resumeStderr = ''
    child.stdout!.on('data', chunk => { resumeStdout += String(chunk) }); child.stderr!.on('data', chunk => { resumeStderr += String(chunk) })
    const resumedCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { child!.kill('SIGKILL'); reject(new Error(`Resume recovery fixture timeout\n${resumeStdout}\n${resumeStderr}`)) }, 45_000)
      child!.once('error', error => { clearTimeout(timer); reject(error) }); child!.once('exit', code => { clearTimeout(timer); resolve(code) })
    })
    expect(resumedCode, resumeStderr + resumeStdout).toBe(0)
    expect(mcpInvocations, resumeStderr + resumeStdout).toBe(1)
    expect(mcpSession).toBe(thread)
    expect(JSON.stringify(requests.at(-1))).toContain('RESUMED_MCP_PROBE_OK')

  } finally {
    child?.kill('SIGKILL'); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    await running?.stop(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true })
  }
}, 60_000)
