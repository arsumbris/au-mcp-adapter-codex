import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { extractLifted, extractObservable, readRollout, rolloutPathFor } from '../src/lift.ts'

// Rollout envelope: { timestamp, type, payload }.
const rollout = [
  JSON.stringify({ timestamp: 'm', type: 'session_meta', payload: { id: 't1', cwd: '/ws' } }),
  // user turn — role=user is skipped (hook-captured + wrapped in <environment_context>).
  JSON.stringify({ timestamp: 't0', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'summarise' }] } }),
  // reasoning -> a thinking block.
  JSON.stringify({ timestamp: 't1', type: 'response_item', payload: { type: 'reasoning', id: 'rs1', summary: [{ type: 'summary_text', text: 'plan the reply' }] } }),
  // assistant message -> a text block (only output_text is lifted).
  JSON.stringify({ timestamp: 't2', type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'msg1', content: [{ type: 'output_text', text: 'Here is the summary.' }] } }),
  // the event_msg mirror of the same text — NOT lifted (we lift from response_item, not event_msg).
  JSON.stringify({ timestamp: 't2', type: 'event_msg', payload: { type: 'agent_message', message: 'Here is the summary.' } }),
  JSON.stringify({ timestamp: 't3', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'call_1', status: 'completed', input: 'tools.exec_command({cmd:"ls"})' } }),
  JSON.stringify({ timestamp: 'w', type: 'world_state', payload: { files: 3 } }),
  '', // trailing blank tolerated
].join('\n')

describe('rollout lifter', () => {
  it('lifts assistant messages + reasoning, skipping everything else', () => {
    const { events } = extractLifted(rollout)
    // only the reasoning + the assistant message, in file order; no user / event_msg / tool / world_state.
    expect(events.map((e) => e.kind)).toEqual(['assistant_message', 'assistant_message'])
    expect(events[0].data).toMatchObject({ uuid: 'rs1', blocks: [{ kind: 'thinking', text: 'plan the reply' }] })
    expect(events[1].data).toMatchObject({ uuid: 'msg1', blocks: [{ kind: 'text', text: 'Here is the summary.' }] })
  })

  it('carries each rollout line’s timestamp onto the lifted event’s `at`', () => {
    const { events } = extractLifted(rollout)
    expect(events[0].at).toBe('t1') // reasoning line's real authored time
    expect(events[1].at).toBe('t2') // assistant message line's real authored time
  })

  it('reads reasoning text from `content` too, not only `summary`', () => {
    const line = JSON.stringify({ timestamp: 'x', type: 'response_item', payload: { type: 'reasoning', id: 'rs9', content: [{ type: 'reasoning_text', text: 'deep thought' }] } })
    const { events } = extractLifted(line)
    expect(events).toHaveLength(1)
    expect(events[0].data).toMatchObject({ blocks: [{ kind: 'thinking', text: 'deep thought' }] })
  })

  it('skips reasoning with no plaintext (encrypted-only) and an empty assistant message', () => {
    const lines = [
      JSON.stringify({ timestamp: 'x', type: 'response_item', payload: { type: 'reasoning', id: 'enc', encrypted_content: 'AAAA' } }),
      JSON.stringify({ timestamp: 'y', type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'empty', content: [] } }),
    ].join('\n')
    expect(extractLifted(lines).events).toHaveLength(0)
  })

  it('re-emits the same stable keys on a full rescan', () => {
    const first = extractLifted(rollout)
    const second = extractLifted(rollout)
    expect(second.events).toEqual(first.events)
    expect(second.events.map(event => event.dedupeKey)).toEqual(['rs1', 'msg1'])
  })

  it('gives an id-less item the same content signature on every rescan', () => {
    const line = JSON.stringify({ timestamp: 'z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'no id here' }] } })
    const first = extractLifted(line)
    expect(first.events).toHaveLength(1)
    expect((first.events[0].data as { uuid: string }).uuid).toMatch(/^a:/) // content-sig, marked assistant
    expect(extractLifted(line).events).toEqual(first.events)
  })

  it('tolerates blank + unparseable lines', () => {
    const { events } = extractLifted('not json\n\n' + rollout)
    expect(events).toHaveLength(2) // the garbage line is skipped, the real items still lift
  })
})

describe('resume and native persistence', () => {
  it('reads compressed rollouts and selects the child transcript', () => {
    const root = mkdtempSync(join(tmpdir(), 'au-lift-compressed-'))
    const child = join(root, 'child.jsonl.zst'); writeFileSync(child, zstdCompressSync(rollout))
    expect(readRollout(child)).toBe(rollout)
    expect(rolloutPathFor({ hook_event_name: 'SubagentStop', transcript_path: '/parent', agent_transcript_path: child })).toBe(child)
  })
  it('replays actual prompts and completed tool outcomes but never fabricates interrupted success', () => {
    const text = [
      { type: 'event_msg', payload: { type: 'user_message', message: 'hello' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>injected</environment_context>' }] } },
      { type: 'response_item', payload: { type: 'function_call', call_id: 'completed', name: 'read_file', arguments: '{"path":"a"}' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'completed', output: 'file contents' } },
      { type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'interrupted', name: 'exec', input: 'something' } },
    ].map(x => JSON.stringify(x)).join('\n')
    expect(extractObservable(text)).toEqual([
      { kind: 'user_prompt', data: { prompt: 'hello' }, at: undefined },
      { kind: 'tool_call', data: { tool: 'read_file', input: { path: 'a' }, tool_use_id: 'completed', response: 'file contents' }, at: undefined },
    ])
  })
})

describe('live and resumed tool identity', () => {
  it.each([
    ['exec_command', 'functions', 'Bash'],
    ['write_stdin', 'functions', 'Bash'],
    ['shell_command', undefined, 'Bash'],
    ['apply_patch', 'functions', 'apply_patch'],
    ['spawn_agent', 'functions', 'spawn_agent'],
    ['spawn_agent', 'multi_agent_v1', 'spawn_agent'],
    ['wait_agent', 'multi_agent_v1', 'multi_agent_v1wait_agent'],
    ['send_input', 'multi_agent_v1', 'multi_agent_v1send_input'],
    ['read_file', 'mcp__au', 'mcp__au__read_file'],
    ['read_file', 'au', 'mcp__au__read_file'],
    ['_read_file', 'mcp__au__', 'mcp__au__read_file'],
    ['exec_command', 'mcp__other', 'mcp__other__exec_command'],
    ['mcp__other__read_file', undefined, 'mcp__other__read_file'],
  ])('replays %s in namespace %s as live hook identity %s', (name, namespace, hookName) => {
    const input = { path: 'example.md' }
    const text = [
      { timestamp: 'start', type: 'response_item', payload: { type: 'function_call', name, namespace, call_id: 'call', arguments: JSON.stringify(input) } },
      { timestamp: 'done', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call', output: 'response' } },
    ].map(line => JSON.stringify(line)).join('\n')
    const live = { tool: hookName, tool_use_id: 'call', input, response: 'response' }
    expect(extractObservable(text)).toEqual([{ kind: 'tool_call', data: live, at: 'done' }])
  })
})
