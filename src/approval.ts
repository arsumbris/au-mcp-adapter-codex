// Adapter-local translation of a bare mediator ask. Kernel requestApproval remains kernel-owned.
import { spawn } from 'node:child_process'
import type { Decision, PendingAction } from '@arsumbris/au-mcp-sdk'

export const APPROVAL_TIMEOUT_MS = 90_000
export const APPROVAL_SCRIPT = `on run argv
set answer to display dialog (item 1 of argv) with title "Arsumbris Codex approval" buttons {"Deny", "Approve"} default button "Deny" cancel button "Deny" giving up after (item 2 of argv as integer)
if gave up of answer then return "Timed out"
return button returned of answer
end run`

/** No shell or interpolation: all untrusted text is one argv value. Timeout also bounds an
 * orphaned dialog if the hook is killed before Node's cancellation handlers can run. */
export async function promptLocalApproval(body: string, timeoutMs: number): Promise<boolean> {
  if (process.platform !== 'darwin' || timeoutMs < 1000) return false
  return runApprovalProcess('/usr/bin/osascript', ['-e', APPROVAL_SCRIPT, '--', body, String(Math.max(1, Math.floor(timeoutMs / 1000)))], timeoutMs)
}

export function runApprovalProcess(binary: string, argv: string[], timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const child = spawn(binary, argv, {stdio: ['ignore', 'pipe', 'ignore']})
    let output = ''
    let finished = false
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']
    const cancel = () => finish(false)
    const timer = setTimeout(cancel, Math.max(0, timeoutMs))
    const finish = (approved: boolean) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      for (const signal of signals) process.off(signal, cancel)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      resolve(approved)
    }
    for (const signal of signals) process.once(signal, cancel)
    child.stdout.on('data', chunk => {
      output += String(chunk)
      if (output.length > 128) finish(false)
    })
    child.once('error', () => finish(false))
    child.once('close', code => finish(code === 0 && output.trim() === 'Approve'))
  })
}

export async function resolveLocalAsk(
  decision: Decision,
  action: PendingAction,
  payload: Record<string, unknown>,
  deadline: number,
  prompt: (body: string, timeoutMs: number) => Promise<boolean> = promptLocalApproval,
): Promise<Decision> {
  if (decision.kind !== 'ask') return decision
  const timeoutMs = Math.min(APPROVAL_TIMEOUT_MS, deadline - Date.now())
  if (timeoutMs < 1000) return {kind: 'deny', reason: 'Approval could not be requested within this action’s time limit. Retry the action to request approval.'}
  // Input is bounded for the native dialog, not changed in the proposed action.
  let input: string
  try { input = JSON.stringify(action.input) ?? String(action.input) } catch { input = '[input unavailable]' }
  const summary = input.length > 8000 ? input.slice(0, 8000) + '\n[truncated; inspect the full action in the chat]' : input
  const body = `${decision.reason}\n\nWorkspace: ${String(payload.cwd ?? '')}\nSession: ${String(payload.agent_id || payload.session_id || '')}\nTool: ${action.tool}\nInput: ${summary}\n\nApprove only this action. A denial, dismissal, or timeout blocks it.`
  let approved = false
  try { approved = await prompt(body, timeoutMs) } catch { /* Fail closed. */ }
  // A late reply can never grant an already-expired request, including injected prompt surfaces.
  return approved && Date.now() < deadline
    ? {kind: 'allow', note: 'The user approved this action through the Arsumbris Codex approval dialog.'}
    : {kind: 'deny', reason: `Approval was denied, dismissed, unavailable, or timed out: ${decision.reason}`}
}
