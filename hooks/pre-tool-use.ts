#!/usr/bin/env node
import { readPayload, mediateAction, observeToolStart, agentFields, preToolOutput, recoverStartupContext, emitHookOutput } from '../src/bridge.ts'
import { markStartupContextEmitted } from '../src/startup-readiness.ts'
import { resolveLocalAsk } from '../src/approval.ts'
const deadline = Date.now() + 135_000
let outputAttempted = false
// Socket connect and stdin have no SDK reply timer. Emit one denial before Codex's
// 150-second hook deadline, rather than letting that harness timeout fail open.
const watchdog = setTimeout(() => {
  if (outputAttempted) { process.exit(0) }
  outputAttempted = true
  process.stdout.write(JSON.stringify(preToolOutput({ kind: 'deny', reason: 'Arsumbris initialization or mediation exceeded its absolute deadline. This action was not admitted; restore the connection and retry.' })), () => process.exit(0))
  setTimeout(() => process.exit(0), 1000).unref()
}, 145_000)
try {
  const payload = await readPayload(process.stdin)
  const tool = String(payload.tool_name ?? '')
  const input = payload.tool_input ?? {}
  const delivery = await recoverStartupContext(payload)
  if (delivery.required && delivery.context) {
    // Recovery is a barrier: this action does not run. Codex gets an opportunity to
    // read the missing instructions before choosing whether and how to retry it.
    outputAttempted = true
    await emitHookOutput({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny',
      permissionDecisionReason: 'Arsumbris startup instructions were just recovered. Read the supplied context, then retry the intended action if it remains appropriate. This action did not run.',
      additionalContext: delivery.context,
    } })
    markStartupContextEmitted(delivery)
  } else {
    markStartupContextEmitted(delivery) // Empty startup context needs no model delivery.
    const action = { tool, input }
    const decision = await resolveLocalAsk(await mediateAction(payload, action), action, payload, deadline)
    const output = preToolOutput(decision)
    const blocked = (output?.hookSpecificOutput as { permissionDecision?: string } | undefined)?.permissionDecision === 'deny'
    if (!blocked) await observeToolStart(payload, { tool, input, tool_use_id: payload.tool_use_id ?? null, ...agentFields(payload) })
    if (output) { outputAttempted = true; await emitHookOutput(output) }
  }
} catch (error) {
  if (outputAttempted) process.stderr.write(`au-codex startup delivery checkpoint: ${String(error)}\n`)
  else { outputAttempted = true; await emitHookOutput(preToolOutput({ kind: 'deny', reason: `Arsumbris initialization could not complete: ${String(error)}. No action was admitted. If the thread is closed or unregistered, resume through the Arsumbris launcher so SessionStart registers it again; restarting the daemon alone does not repair local registration. Otherwise restore the reported connection and retry.` })) }
} finally { clearTimeout(watchdog) }
