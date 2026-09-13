#!/usr/bin/env node
// Codex hooks retain the root session_id; agent_id identifies this child thread.
import { EventKind } from '@arsumbris/au-mcp-sdk'
import { readPayload, observeEvent, resolveContext, resolveSessionHandle, agentFields, recoverStartupContext, emitHookOutput } from '../src/bridge.ts'
import { registerLaunchSession } from '../src/thread-registry.ts'
import { beginStartup, markStartupContextEmitted } from '../src/startup-readiness.ts'
const payload = await readPayload(process.stdin)
try {
  const { workspace, session } = resolveContext(payload)
  const handle = resolveSessionHandle()
  if (!handle) throw new Error('Missing AU_MCP_SESSION')
  await registerLaunchSession(session, workspace, handle)
  beginStartup({ workspace, session, handle }, payload)
  await observeEvent(payload, EventKind.SessionStart, { source: 'subagent', ...agentFields(payload) })
  const delivery = await recoverStartupContext(payload)
  if (delivery.context) { await emitHookOutput({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: delivery.context } }) }
  markStartupContextEmitted(delivery)
} catch (error) {
  process.stderr.write(`au-codex subagent initialization: ${String(error)}\n`)
}
