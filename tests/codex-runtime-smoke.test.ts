// Opt-in harness proof: real Codex, local fake Responses SSE, real au daemon, no API/model account.
// Event shapes mirror pinned Codex core/tests/common/responses.rs.
import { it, expect, vi } from 'vitest'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startDaemon } from '@arsumbris/au-mcp'
import { EventKind, type Plugin, type SessionEvent } from '@arsumbris/au-mcp-sdk'
import { prepareLaunch } from '../src/launch.ts'
import { spawnFixture } from './fixture-exec.ts'
import { codexResumeRef } from '../src/resume-ref.ts'

import { profileEngine } from './profile-engine.ts'

const binary = process.env.CODEX_TEST_BINARY
it.skipIf(!binary)('real Codex attributes profile tool calls and delivers complete 70KB context with native MCP thread identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'au-codex-runtime-smoke-'))
  vi.stubEnv('CODEX_HOME', join(root, 'home'))
  const workspace = join(root, 'workspace')
  mkdirSync(join(workspace, '.arsumbris'), { recursive: true })
  const seen: SessionEvent[] = []
  const invocations: Array<{ profile: string; session?: string }> = []
  const profiles = ['alpha', 'beta'] as const
  const plugins: Plugin[] = [
    { manifest: { id: 'mcp.fixture_recorder', name: 'fixture_recorder', contractVersion: 0, kind: 'hook', shapes: ['observer'] }, onEvent: event => { seen.push(event) } },
    ...profiles.map(profile => ({
      manifest: { id: `mcp.fixture_probe_${profile}`, name: `fixture_probe_${profile}`, contractVersion: 0, kind: 'tool' as const, description: `Read-only ${profile} fixture probe`, inputSchema: { type: 'object', properties: {} } },
      invoke: async (_input: unknown, context?: { session?: string }) => { invocations.push({ profile, session: context?.session }); return { content: { marker: `ACTUAL_MCP_PROBE_OK_${profile}` } } },
    })),
  ]
  const engine = await profileEngine(workspace)
  for (const profile of profiles) engine.add(profile, [`fixture_probe_${profile}`])
  const running = await startDaemon({ workspace, plugins, approval: async () => 'granted' })
  const requests = new Map<string, Record<string, unknown>[]>()
  const errors: string[] = []
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || !request.url?.endsWith('/responses')) { response.writeHead(404); response.end(); return }
    try {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      const thread = String((body.client_metadata as Record<string, unknown>).thread_id)
      const captured = requests.get(thread) ?? []
      captured.push(body); requests.set(thread, captured)
      const profile = JSON.stringify(body).includes('PROFILE_ALPHA_SENTINEL') ? 'alpha' : 'beta'
      const id = `fixture-${thread}-${captured.length}`
      const item = captured.length === 1
        ? { type: 'tool_search_call', call_id: `fixture-search-${profile}`, execution: 'client', arguments: { query: `fixture_probe_${profile}`, limit: 1 } }
        : captured.length === 2 ? { type: 'function_call', call_id: `fixture-call-${profile}`, namespace: 'mcp__au', name: `fixture_probe_${profile}`, arguments: '{}' }
        : { type: 'message', role: 'assistant', id: `fixture-message-${profile}`, content: [{ type: 'output_text', text: captured.length > 3 ? `LOCAL_FIXTURE_RESUMED_${profile}` : `LOCAL_FIXTURE_DONE_${profile}` }] }
      const events = [
        { type: 'response.created', response: { id } },
        { type: 'response.output_item.done', item },
        { type: 'response.completed', response: { id, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } },
      ]
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
    } catch (error) { errors.push(String(error)); response.writeHead(500); response.end('fixture parse failed') }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const children: ReturnType<typeof spawn>[] = []
  try {
    const results = await Promise.all(profiles.map(async profile => {
      vi.stubEnv('CODEX_HOME', join(root, profile))
      const marker = `PROFILE_${profile.toUpperCase()}_SENTINEL`
      const content = `${marker}\nFIRST_SENTINEL\n${'a'.repeat(35_000)}\nMIDDLE_SENTINEL\n${'b'.repeat(35_000)}\nLAST_SENTINEL`
      const skill = `profile_${profile}_skill`
      const launch = await prepareLaunch({ entry: workspace, binary: binary!, skills: [skill], inject: [profile], profile }, (script, _profile, select) => {
        if (select?.length === 0) return []
        const generationHome = join(root, 'generated', _profile.profile ?? 'default')
        const source = join(generationHome, script)
        mkdirSync(source, { recursive: true })
        if (script === 'gen-skills.ts') {
          mkdirSync(join(source, skill))
          writeFileSync(join(source, skill, 'SKILL.md'), `---\nname: ${skill}\ndescription: This skill is exclusive to ${profile}.\n---\n\n${profile} fixture skill body.\n`)
        } else writeFileSync(join(source, 'content.md'), content)
        return [source]
      }, async () => {})
      const overrides = {
        model: 'gpt-5.4', model_provider: 'fixture',
        'model_providers.fixture.name': 'Local fixture',
        'model_providers.fixture.base_url': `http://127.0.0.1:${address.port}/v1`,
        'model_providers.fixture.wire_api': 'responses',
        'model_providers.fixture.requires_openai_auth': false,
        'features.enable_request_compression': false,
        'features.apps': false,
        'features.plugins': false,
        'analytics.enabled': false,
        // This fixed read-only fixture server is the only automatically approved server.
        'mcp_servers.au.default_tools_approval_mode': 'approve',
      }
      const argv = ['exec', '--skip-git-repo-check', '--dangerously-bypass-hook-trust', '--json', '--cd', workspace, ...Object.entries(overrides).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]), 'Run only the fixture probe and finish.']
      const child = spawnFixture(launch, argv)
      children.push(child)
      let stdout = ''; let stderr = ''
      child.stdout!.on('data', chunk => { stdout += String(chunk) })
      child.stderr!.on('data', chunk => { stderr += String(chunk) })
      const code = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Codex fixture timed out\n${stderr}\n${stdout}`)) }, 45_000)
        child.once('error', error => { clearTimeout(timer); reject(error) })
        child.once('exit', code => { clearTimeout(timer); resolve(code) })
      })
      expect(code, stderr + stdout).toBe(0)
      const started = stdout.split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>).find(event => event.type === 'thread.started')
      const thread = String(started?.thread_id)
      const captured = requests.get(thread) ?? []
      expect(captured.length, stderr + stdout).toBeGreaterThanOrEqual(3)
      const first = JSON.stringify(captured[0])
      for (const sentinel of [marker, 'FIRST_SENTINEL', 'MIDDLE_SENTINEL', 'LAST_SENTINEL', skill]) expect(first.includes(sentinel), `Missing ${sentinel}\n${stderr}${stdout}`).toBe(true)
      expect(first.includes(JSON.stringify(content).slice(1, -1)), 'Complete injected content must reach the model request').toBe(true)
      const other = profile === 'alpha' ? 'beta' : 'alpha'
      for (const absent of [`PROFILE_${other.toUpperCase()}_SENTINEL`, `profile_${other}_skill`, `fixture_probe_${other}`]) expect(first.includes(absent), `Other profile leaked: ${absent}`).toBe(false)
      expect(invocations.filter(call => call.profile === profile), stderr + stdout).toEqual([{ profile, session: thread }])
      expect(JSON.stringify(captured.at(-1)).includes(`ACTUAL_MCP_PROBE_OK_${profile}`), stderr + stdout).toBe(true)
      expect(seen.some(event => event.session === thread && event.kind === EventKind.SessionStart)).toBe(true)
      expect(seen.some(event => event.session === thread && event.kind === EventKind.ToolCall)).toBe(true)
      return { thread, home: launch.env.CODEX_HOME, profile, skill, marker, content, overrides, launch }
    }))
    expect(errors).toEqual([])
    expect(results[0].thread).not.toBe(results[1].thread)
    expect(results[0].home).not.toBe(results[1].home)
    expect(requests.size).toBe(2)
    expect(seen.every(event => results.some(result => result.thread === event.session))).toBe(true)
    // Resume regenerates capabilities and never executes prior tool calls again.
    const beforeResume = new Map(results.map(result => [result.thread, seen.filter(event => event.session === result.thread)]))
    await Promise.all(results.map(async original => {
      vi.stubEnv('CODEX_HOME', original.home)
      const resumed = await prepareLaunch({ entry: workspace, binary: binary!, resume: codexResumeRef(original.thread, original.launch.env)! }, script => [join(root, 'generated', original.profile, script)], async () => {})
      expect(resumed.session).not.toBe(original.launch.session)
      expect(resumed.env.CODEX_HOME).toBe(original.home)
      const argv = ['exec', '--cd', workspace, 'resume', '--skip-git-repo-check', '--dangerously-bypass-hook-trust', '--json', ...Object.entries(original.overrides).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]), original.thread, 'Continue the local fixture without calling tools.']
      const child = spawnFixture(resumed, argv)
      children.push(child)
      let stdout = ''; let stderr = ''
      child.stdout!.on('data', chunk => { stdout += String(chunk) })
      child.stderr!.on('data', chunk => { stderr += String(chunk) })
      const code = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Codex resume fixture timed out\n${stderr}\n${stdout}`)) }, 45_000)
        child.once('error', error => { clearTimeout(timer); reject(error) })
        child.once('exit', code => { clearTimeout(timer); resolve(code) })
      })
      expect(code, stderr + stdout).toBe(0)
      const started = stdout.split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>).find(event => event.type === 'thread.started')
      expect(started?.thread_id, stderr + stdout).toBe(original.thread)
      const captured = requests.get(original.thread)!
      expect(captured.length, stderr + stdout).toBe(4)
      const resumedInput = JSON.stringify(captured[3])
      expect(resumedInput.includes(original.skill)).toBe(true)
      expect(resumedInput.includes(JSON.stringify(original.content).slice(1, -1))).toBe(true)
      const other = original.profile === 'alpha' ? 'beta' : 'alpha'
      for (const absent of [`PROFILE_${other.toUpperCase()}_SENTINEL`, `profile_${other}_skill`, `fixture_probe_${other}`]) expect(resumedInput.includes(absent), `Other profile leaked on resume: ${absent}`).toBe(false)
      const oldEvents = beforeResume.get(original.thread)!
      const currentEvents = seen.filter(event => event.session === original.thread)
      const starts = currentEvents.filter(event => event.kind === EventKind.SessionStart)
      expect(starts).toHaveLength(2)
      expect((starts[1].data as { source?: string }).source).toBe('resume')
      expect(starts[1].run).toBe(starts[0].run + 1)
      // Historical tool starts/completions are replayed inertly, never observed/persisted again.
      for (const kind of [EventKind.ToolStart, EventKind.ToolCall]) {
        expect(currentEvents.filter(event => event.kind === kind)).toHaveLength(oldEvents.filter(event => event.kind === kind).length)
      }
      expect(invocations.filter(call => call.profile === original.profile)).toEqual([{ profile: original.profile, session: original.thread }])
    }))
    expect(requests.size).toBe(2)
    expect(errors).toEqual([])

  } finally {
    for (const child of children) child.kill('SIGKILL')
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    await running.stop()
    await engine.close()
    vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true })
  }
}, 60_000)
