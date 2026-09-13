#!/usr/bin/env node
// Forward Codex's result wrapper and modern mutation provenance. A delete pins last-live
// content and separately attributes its deletion commit; a rename retains the old path.
import { EventKind, pinnedFileTarget, commitReferent } from '@arsumbris/au-mcp-sdk'
import { readPayload, observeEvent, agentFields, boundedContext } from '../src/bridge.ts'
import { liftRollout } from '../src/lift.ts'
import { extractTouch } from '../src/touched.ts'
import { CODEX_FILE_ACCESS } from '../src/surface.ts'

const payload = await readPayload(process.stdin)
const touch = extractTouch(payload.tool_response)
const target = pinnedFileTarget(touch) ?? undefined
const access = target ? (touch?.access ?? 'write') : CODEX_FILE_ACCESS[String(payload.tool_name ?? '')]
const from = touch?.from
const committed = touch?.priorCommit ? (commitReferent(touch.commit) ?? undefined) : undefined
const reviewText = await observeEvent(payload, EventKind.ToolCall, {
  tool: payload.tool_name ?? null,
  input: payload.tool_input ?? null,
  tool_use_id: payload.tool_use_id ?? null,
  response: payload.tool_response ?? null,
  ...(target ? { target } : {}),
  ...(access ? { access } : {}),
  ...(from ? { from } : {}),
  ...(committed ? { committed } : {}),
  ...agentFields(payload),
})
if (reviewText) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: boundedContext(reviewText) },
    }),
  )
}
await liftRollout(payload)
process.exit(0)
