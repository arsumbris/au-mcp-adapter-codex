// Real Codex lifecycle acceptance against a localhost Responses fixture and real au daemon.
// No hosted model or account. Pinned sources: multi_agents_spec.rs, hook_runtime.rs,
// core/tests/suite/compact.rs::snapshot_request_shape_mid_turn_continuation_compaction.
import { it, expect, vi } from 'vitest'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startDaemon } from '@arsumbris/au-mcp'
import { EventKind, type Plugin, type SessionEvent } from '@arsumbris/au-mcp-sdk'
import { prepareLaunch } from '../src/launch.ts'
import { spawnFixture } from './fixture-exec.ts'
import { adapterStateDir } from '../src/launch-env.ts'
import { cleanupProcessThreads } from '../src/process-cleanup.ts'

const binary = process.env.CODEX_TEST_BINARY
const message = (id: string, text: string) => ({ type: 'message', role: 'assistant', id, content: [{ type: 'output_text', text }] })
const call = (id: string, namespace: string, name: string, args: unknown) => ({ type: 'function_call', call_id: id, namespace, name, arguments: JSON.stringify(args) })
interface FixtureReply { item: unknown; tokens?: number }
interface CapturedRequest { body: Record<string, unknown>; headers: IncomingHttpHeaders; path: string }

async function runFixture(
  handle: (request: CapturedRequest, captured: CapturedRequest[]) => FixtureReply,
  overrides: Record<string, unknown>,
  prompt: string,
  check: (result: { events: SessionEvent[]; requests: CapturedRequest[]; stdout: string; stderr: string; stateDir: string; probes: Array<{ session?: string; input: unknown }> }) => void,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'au-codex-lifecycle-'))
  vi.stubEnv('CODEX_HOME', join(root, 'home'))
  const workspace = join(root, 'workspace'); mkdirSync(join(workspace, '.arsumbris'), { recursive: true })
  const events: SessionEvent[] = []
  const probes: Array<{ session?: string; input: unknown }> = []
  const plugins: Plugin[] = [
    { manifest: { id: 'mcp.lifecycle_recorder', name: 'lifecycle_recorder', contractVersion: 0, kind: 'hook', shapes: ['observer'] }, onEvent: event => { events.push(event) } },
    { manifest: { id: 'mcp.lifecycle_probe', name: 'lifecycle_probe', contractVersion: 0, kind: 'tool', description: 'Read-only lifecycle fixture probe.', inputSchema: { type: 'object', properties: { who: { type: 'string' } } } },
      invoke: async (input, context) => { probes.push({ session: context?.session, input }); return { content: { marker: 'LIFECYCLE_PROBE_ACK' } } } },
  ]
  const running = await startDaemon({ workspace, plugins, approval: async () => 'granted' })
  const requests: CapturedRequest[] = []
  const errors: string[] = []
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || !request.url?.endsWith('/responses')) throw new Error(`Unexpected fixture endpoint ${request.method} ${request.url}`)
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const captured = { body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>, headers: request.headers, path: request.url }
      requests.push(captured)
      const reply = handle(captured, requests)
      const id = `lifecycle-response-${requests.length}`
      const events = [
        { type: 'response.created', response: { id } },
        { type: 'response.output_item.done', item: reply.item },
        { type: 'response.completed', response: { id, usage: { input_tokens: reply.tokens ?? 0, output_tokens: 0, total_tokens: reply.tokens ?? 0 } } },
      ]
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
    } catch (error) { errors.push(String(error)); response.writeHead(500); response.end('fixture failed') }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  let child: ReturnType<typeof spawn> | undefined
  try {
    const port = (server.address() as { port: number }).port
    const launch = await prepareLaunch({ entry: workspace, binary: binary!, skills: ['lifecycle_skill'], inject: ['lifecycle_inject'] }, (script, _profile, select) => {
      if (select?.length === 0) return []
      const generationHome = join(root, 'generated', _profile.profile ?? 'default')
      const source = join(generationHome, script); mkdirSync(source, { recursive: true })
      if (script === 'gen-skills.ts') {
        mkdirSync(join(source, 'lifecycle_skill'))
        writeFileSync(join(source, 'lifecycle_skill', 'SKILL.md'), '---\nname: lifecycle_skill\ndescription: Profile-selected lifecycle fixture skill.\n---\n\nLIFECYCLE_SKILL_BODY_SENTINEL\n')
      } else writeFileSync(join(source, 'content.md'), 'LIFECYCLE_STATIC_INJECT_SENTINEL\nApply the selected profile to every child turn.\n')
      return [source]
    })
    const config = {
      model: 'gpt-5.4', model_provider: 'fixture',
      'model_providers.fixture.name': 'Local lifecycle fixture',
      'model_providers.fixture.base_url': `http://127.0.0.1:${port}/v1`,
      'model_providers.fixture.wire_api': 'responses',
      'model_providers.fixture.requires_openai_auth': false,
      'features.enable_request_compression': false, 'features.apps': false, 'features.plugins': false,
      'features.multi_agent': true, 'features.multi_agent_v2': false,
      'analytics.enabled': false, 'mcp_servers.au.default_tools_approval_mode': 'approve', ...overrides,
    }
    const argv = ['exec', '--skip-git-repo-check', '--dangerously-bypass-hook-trust', '--json', '--cd', workspace, ...Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]), prompt]
    child = spawnFixture(launch, argv)
    let stdout = ''; let stderr = ''
    child.stdout!.on('data', chunk => { stdout += String(chunk) }); child.stderr!.on('data', chunk => { stderr += String(chunk) })
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { child!.kill('SIGKILL'); reject(new Error(`Lifecycle fixture timed out\n${stderr}\n${stdout}\n${errors.join('\n')}`)) }, 50_000)
      child!.once('error', error => { clearTimeout(timer); reject(error) })
      child!.once('exit', code => { clearTimeout(timer); resolve(code) })
    })
    expect(code, stderr + stdout + errors.join('\n')).toBe(0)
    expect(errors, stderr + stdout).toEqual([])
    await cleanupProcessThreads({ ...process.env, ...launch.env, AU_CODEX_RUN_ID: launch.session })
    check({ events, requests, stdout, stderr, stateDir: adapterStateDir(launch.env)!, probes })
  } finally {
    child?.kill('SIGKILL'); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    await running.stop(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true })
  }
}
function threadOf(request: CapturedRequest): string { return String((request.body.client_metadata as Record<string, unknown>)?.thread_id) }
function toolOutput(request: CapturedRequest, id: string): string {
  const input = request.body.input as Array<Record<string, unknown>>
  const output = input?.find(item => item.type === 'function_call_output' && item.call_id === id)?.output
  return typeof output === 'string' ? output : JSON.stringify(output)
}

it.skipIf(!binary)('real Codex child thread survives two turns and never rebinds its parent MCP calls', async () => {
  let parent = ''; let child = ''
  const counts = new Map<string, number>()
  await runFixture(request => {
    const thread = threadOf(request); if (!parent) parent = thread
    const count = (counts.get(thread) ?? 0) + 1; counts.set(thread, count)
    if (thread !== parent) {
      child = thread
      if (count === 1) return { item: { type: 'tool_search_call', call_id: 'child-search', execution: 'client', arguments: { query: 'lifecycle_probe', limit: 1 } } }
      if (count === 2 || count === 4) return { item: call(`child-probe-${count}`, 'mcp__au', 'lifecycle_probe', { who: `child-${count === 2 ? 1 : 2}` }) }
      return { item: message(`child-message-${count}`, count === 3 ? 'CHILD_TURN_ONE_DONE' : 'CHILD_TURN_TWO_DONE') }
    }
    if (count === 1) return { item: call('spawn-child', 'multi_agent_v1', 'spawn_agent', { message: 'Use the lifecycle fixture probe, then finish this child turn.', agent_type: 'default' }) }
    if (count === 2) {
      const output = JSON.parse(toolOutput(request, 'spawn-child')) as { agent_id?: string }
      if (!output.agent_id) throw new Error(`Spawn did not return child identity: ${toolOutput(request, 'spawn-child')}`)
      child = output.agent_id
      return { item: call('wait-child-one', 'multi_agent_v1', 'wait_agent', { targets: [child], timeout_ms: 10_000 }) }
    }
    if (count === 3) return { item: call('send-child-two', 'multi_agent_v1', 'send_input', { target: child, message: 'Run the lifecycle probe again for your second turn, then finish.' }) }
    if (count === 4) return { item: call('wait-child-two', 'multi_agent_v1', 'wait_agent', { targets: [child], timeout_ms: 10_000 }) }
    if (count === 5) return { item: { type: 'tool_search_call', call_id: 'parent-search', execution: 'client', arguments: { query: 'lifecycle_probe', limit: 1 } } }
    if (count === 6) return { item: call('parent-probe', 'mcp__au', 'lifecycle_probe', { who: 'parent' }) }
    return { item: message('parent-done', 'PARENT_LIFECYCLE_DONE') }
  }, {}, 'Explicitly spawn one child agent, wait for it, send a second task, wait again, and then finish the parent fixture.', result => {
    const childOutputs = result.requests.filter(request => threadOf(request) === child).flatMap(request => (request.body.input as Array<Record<string, unknown>>).filter(item => item.type === 'function_call_output' || item.type === 'tool_search_output'))
    const diagnostic = result.stderr + result.stdout + '\nChild tool results: ' + JSON.stringify(childOutputs.filter(item => item.type === 'function_call_output').map(item => ({ id: item.call_id, output: JSON.stringify(item.output).slice(0, 300) }))) + '\nObserved: ' + JSON.stringify(result.events.map(event => ({ session: event.session, kind: event.kind, run: event.run })))
    expect(parent).not.toBe(child)
    expect(counts.get(child), diagnostic).toBe(5)
    const childFirstRequest = JSON.stringify(result.requests.find(request => threadOf(request) === child)?.body)
    expect({ staticInject: childFirstRequest.includes('LIFECYCLE_STATIC_INJECT_SENTINEL'), skill: childFirstRequest.includes('lifecycle_skill') }, diagnostic).toEqual({ staticInject: true, skill: true })
    expect(result.probes, diagnostic).toEqual([{ session: child, input: { who: 'child-1' } }, { session: child, input: { who: 'child-2' } }, { session: parent, input: { who: 'parent' } }])
    const childEvents = result.events.filter(event => event.session === child)
    expect(childEvents.filter(event => event.kind === EventKind.SessionStart), diagnostic).toHaveLength(1)
    const childCalls = childEvents.filter(event => event.kind === EventKind.ToolCall && (event.data as { tool?: string }).tool === 'mcp__au__lifecycle_probe')
    expect(childCalls, diagnostic).toHaveLength(2)
    expect(new Set(childCalls.map(event => event.run)).size).toBe(1)
    expect(childEvents.filter(event => event.kind === EventKind.AssistantMessage).map(event => (event.data as { uuid?: string }).uuid), diagnostic).toEqual(['child-message-3', 'child-message-5'])
    expect(childEvents.filter(event => event.kind === EventKind.SessionEnd), diagnostic).toEqual([])
    expect(result.events.filter(event => event.session === parent && event.kind === EventKind.AssistantMessage).map(event => (event.data as { uuid?: string }).uuid), diagnostic).toEqual(['parent-done'])
    const records = readdirSync(join(result.stateDir, 'threads')).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(result.stateDir, 'threads', name), 'utf8')) as { session: string; active: boolean })
    expect(records.map(record => record.session).sort()).toEqual([parent, child].sort())
    expect(records.every(record => record.active === false), diagnostic).toBe(true)
    expect(diagnostic).not.toContain('not registered for this launch')
  })
}, 60_000)

it.skipIf(!binary)('real Codex auto-compaction fires the adapter hook and continues with the compacted summary', async () => {
  await runFixture((_request, requests) => {
    if (requests.length === 1) return { item: call('compact-trigger', 'functions', 'update_plan', { plan: [{ step: 'Exercise local compaction', status: 'completed' }] }), tokens: 290_000 }
    if (requests.length === 2) return { item: message('compact-summary', 'LOCAL_COMPACTION_SUMMARY_SENTINEL'), tokens: 10 }
    return { item: message('compact-done', 'LOCAL_COMPACTION_CONTINUED'), tokens: 10 }
  }, { model_context_window: 300_000, model_auto_compact_token_limit: 200_000, 'features.remote_compaction_v2': false }, 'Run the local compaction fixture and continue after summarization.', result => {
    const diagnostic = result.stderr + result.stdout
    expect(result.requests, diagnostic).toHaveLength(3)
    const compactions = result.events.filter(event => event.kind === EventKind.Compaction)
    expect(compactions, diagnostic).toHaveLength(1)
    expect(compactions[0].data).toMatchObject({ trigger: 'auto' })
    expect(JSON.stringify(result.requests[2].body)).toContain('LOCAL_COMPACTION_SUMMARY_SENTINEL')
    expect(JSON.stringify(result.requests[2].body), diagnostic).toContain('LIFECYCLE_STATIC_INJECT_SENTINEL')
    expect(JSON.stringify(result.requests[2].body), diagnostic).toContain('lifecycle_skill')
    expect(result.stdout).toContain('LOCAL_COMPACTION_CONTINUED')
    expect(new Set(result.events.map(event => event.run)).size).toBe(1)
  })
}, 60_000)
