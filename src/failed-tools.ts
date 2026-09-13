// Source: Codex 0.153.2 / 657a993cbee87acf52d14b758ce49dbd46d1b8eb,
// protocol/items.rs (CommandExecution, FileChange), protocol/protocol.rs (PatchApplyEnd),
// rollout/policy.rs. FunctionCallOutputPayload.success is NOT serialized; never infer an
// error from prose in function_call_output. CommandExecution is durable in paginated
// histories, while legacy histories persist PatchApplyEnd but not ExecCommandEnd.
import { EventKind } from '@arsumbris/au-mcp-sdk'
import { codexHookToolName } from './canonical-tools.ts'

export type PendingTools = Record<string, unknown>
export interface NativeFailureEvent {
  kind: string
  dedupeKey: string
  data: { uuid: string; tool: string; tool_use_id: string; input: unknown; error: string; exit_code?: number }
  at?: string
}
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/** Lift only explicit failed native completion records; successful/declined tools remain
 * hook-owned. ToolFailed augments ToolCall: Codex PostToolUse can fire for a nonzero exit. */
export function extractToolFailed(text: string, pending: PendingTools = {}): { events: NativeFailureEvent[]; pending: PendingTools } {
  const seen = new Set<string>()
  const events: NativeFailureEvent[] = []
  const calls = new Map(Object.entries(pending))
  for (const raw of text.split('\n')) {
    let env: Record<string, unknown> | undefined
    try { env = object(JSON.parse(raw)) } catch { continue }
    if (!env) continue
    const payload = object(env.payload)
    if (!payload) continue
    if (env.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(String(payload.type)) && typeof payload.call_id === 'string') {
      if (!['Bash', 'apply_patch'].includes(codexHookToolName(payload.name, payload.namespace) ?? '')) continue
      let input = payload.arguments ?? payload.input ?? null
      if (typeof input === 'string') { try { input = JSON.parse(input) } catch { /* preserve custom-tool text */ } }
      calls.set(payload.call_id, input)
      continue
    }
    if (env.type !== 'event_msg') continue
    const item = payload.type === 'item_completed' ? object(payload.item) : payload.type === 'patch_apply_end' ? payload : undefined
    if (!item) continue
    const shell = item.type === 'CommandExecution'
    const patch = item.type === 'FileChange' || item.type === 'patch_apply_end'
    if (!shell && !patch) continue
    // UserShell is a human command, not an agent tool. Unknown future sources need review.
    if (shell && item.source !== undefined && !['agent', 'unified_exec_startup', 'unified_exec_interaction'].includes(String(item.source))) continue
    const id = item.type === 'patch_apply_end' ? item.call_id : item.id
    if (typeof id !== 'string' || !id) continue
    const input = calls.get(id)
    if (['completed', 'failed', 'declined'].includes(String(item.status))) calls.delete(id)
    if (item.status !== 'failed') continue
    const uuid = `failure:${id}`
    if (seen.has(uuid)) continue
    const exit = shell && typeof item.exit_code === 'number' && Number.isSafeInteger(item.exit_code) ? item.exit_code : undefined
    const diagnostic = [item.stderr, item.formatted_output, item.aggregated_output].find(value => typeof value === 'string' && value.trim())
    const error = typeof diagnostic === 'string' ? diagnostic : shell
      ? `Command execution failed${exit === undefined ? '' : ` with exit code ${exit}`}.`
      : 'Patch application failed.'
    seen.add(uuid)
    events.push({
      kind: EventKind.ToolFailed,
      dedupeKey: uuid,
      data: {
        uuid, tool: shell ? 'Bash' : 'apply_patch', tool_use_id: id,
        input: input ?? (shell ? { command: item.command ?? null, cwd: item.cwd ?? null } : { changes: item.changes ?? null }),
        error, ...(exit !== undefined ? { exit_code: exit } : {}),
      },
      ...(typeof env.timestamp === 'string' ? { at: env.timestamp } : {}),
    })
  }
  return { events, pending: Object.fromEntries(calls) }
}
