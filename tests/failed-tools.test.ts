import { describe, expect, it } from 'vitest'
import { extractToolFailed } from '../src/failed-tools.ts'
const line = (payload: unknown, type = 'event_msg') => JSON.stringify({ timestamp: '2026-09-05T17:46:29.507Z', type, payload })
const shell = { type: 'CommandExecution', id: 'call-1', source: 'unified_exec_startup', status: 'failed', command: ['/bin/zsh', '-lc', 'exit 7'], cwd: 'file:///vault', exit_code: 7, stdout: '', stderr: '', aggregated_output: '' }
const completed = (item: unknown) => line({ type: 'item_completed', item })

describe('source-verified native failure lifting', () => {
  it('captures a structured nonzero shell failure with canonical identity and original arguments', () => {
    const text = line({ type: 'function_call', call_id: 'call-1', name: 'exec_command', arguments: '{"cmd":"exit 7"}' }, 'response_item') + '\n' + completed(shell)
    const { events } = extractToolFailed(text)
    expect(events).toEqual([{ kind: 'tool_failed', dedupeKey: 'failure:call-1', at: '2026-09-05T17:46:29.507Z', data: { uuid: 'failure:call-1', tool: 'Bash', tool_use_id: 'call-1', input: { cmd: 'exit 7' }, exit_code: 7, error: 'Command execution failed with exit code 7.' } }])
    expect(extractToolFailed(text).events).toEqual(events)
  })
  it('captures structured paginated and legacy patch failures once per call', () => {
    const patch = { type: 'FileChange', id: 'patch-1', status: 'failed', stderr: 'No matching context', changes: {} }
    const legacy = { ...patch, type: 'patch_apply_end', call_id: 'patch-1', success: false }
    const { events } = extractToolFailed(completed(patch) + '\n' + line(legacy))
    expect(events).toHaveLength(1)
    expect(events[0]!.data).toMatchObject({ tool: 'apply_patch', tool_use_id: 'patch-1', error: 'No matching context' })
  })
  it('does not label successful, declined, unfinished, or human-issued commands as tool failures', () => {
    const text = ['completed', 'declined', 'in_progress'].map(status => completed({ ...shell, status })).concat(completed({ ...shell, source: 'user_shell' })).join('\n')
    expect(extractToolFailed(text).events).toEqual([])
  })
  it('never guesses failure from output prose or a serialization-only success field', () => {
    const output = line({ type: 'function_call_output', call_id: 'call-1', output: 'Error: Process exited with code 7', success: false }, 'response_item')
    expect(extractToolFailed(output).events).toEqual([])
  })
  it('ignores malformed and unrelated records without consuming their later valid identity', () => {
    const text = 'partial\n' + line({ type: 'item_completed', item: { type: 'McpToolCall', id: 'call-1', status: 'failed' } }) + '\n' + completed(shell)
    expect(extractToolFailed(text).events).toHaveLength(1)
  })
})
