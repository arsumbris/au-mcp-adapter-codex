#!/usr/bin/env node
import { EventKind } from '@arsumbris/au-mcp-sdk'
import { readPayload, observeEvent, resolveContext, resolveSessionHandle, buildHandleMissingNote, recoverStartupContext, emitHookOutput } from '../src/bridge.ts'
import { registerLaunchSession } from '../src/thread-registry.ts'
import { beginStartup, markStartupContextEmitted } from '../src/startup-readiness.ts'
let outputAttempted = false
const payload = await readPayload(process.stdin)
try {
  const { workspace, session } = resolveContext(payload)
  const handle = resolveSessionHandle()
  if (!handle) throw new Error(buildHandleMissingNote())
  await registerLaunchSession(session, workspace, handle)
  beginStartup({ workspace, session, handle }, payload)
  await observeEvent(payload, EventKind.SessionStart, { source: payload.source ?? null, transcript: payload.transcript_path ?? null })
  const delivery = await recoverStartupContext(payload)
  if (delivery.context) { outputAttempted = true; await emitHookOutput({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: delivery.context } }) }
  markStartupContextEmitted(delivery)
} catch (error) {
  process.stderr.write(`au-codex startup: ${String(error)}\n`)
  if (!outputAttempted) { outputAttempted = true; await emitHookOutput({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `Arsumbris initialization is pending: ${String(error)}. Work will pause until startup context and resumed history can be recovered.` } }) }
}
