// Codex hook boundary: raw thread identity, shared launch contract, explicit mediation failure.
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  connectSocket, createDaemonClient, EventKind, LAUNCH_ENV, parseProfile,
  parseSessionHandle, socketPath, traceEvent,
  type DaemonClient, type Decision, type PendingAction, type ReplayEvent,
} from '@arsumbris/au-mcp-sdk'
import { codexAdapterInfo } from './surface.ts'
import { toolStartupContext } from './advertise.ts'
import { assertLaunchSession, registrationGeneration, withThreadLock, markLaunchSessionClosed } from './thread-registry.ts'
import { resolveLaunchEnv } from './launch-env.ts'
import { prepareStartupDelivery, generatedStartupContext, isStartupReady, type StartupDelivery } from './startup-readiness.ts'
import { openCodexSession, currentDaemonIdentity } from './session-open.ts'

export const REQUEST_TIMEOUT_MS = 8_000
export const MEDIATION_TIMEOUT_MS = 110_000
export const resolveSessionHandle = (): string | undefined => parseSessionHandle(resolveLaunchEnv()[LAUNCH_ENV.SESSION])
export const resolveProfile = (): string | undefined => parseProfile(resolveLaunchEnv()[LAUNCH_ENV.PROFILE])
export const resolveResume = (payload: { source?: unknown } | null): boolean => payload?.source === 'resume'

export function resolveEntry(start: string): string {
  const explicit = resolveLaunchEnv()[LAUNCH_ENV.WORKSPACE]
  if (explicit?.trim()) return resolve(explicit)
  let dir = resolve(start)
  for (;;) {
    if (existsSync(join(dir, '.arsumbris', 'repo.yaml'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return resolve(start)
    dir = parent
  }
}
export interface HookContext { workspace: string; session: string }
export function resolveContext(payload: { cwd?: string; session_id?: string; agent_id?: string } | null): HookContext {
  return { workspace: resolveEntry(payload?.cwd ?? process.cwd()), session: payload?.agent_id?.trim() || payload?.session_id || 'unknown-session' }
}
export function agentFields(payload: Record<string, unknown> | null): { agent_id?: string; agent_type?: string } {
  return {
    ...(typeof payload?.agent_id === 'string' ? { agent_id: payload.agent_id } : {}),
    ...(typeof payload?.agent_type === 'string' ? { agent_type: payload.agent_type } : {}),
  }
}
export async function readPayload(stream: AsyncIterable<string | Buffer>): Promise<Record<string, unknown>> {
  let raw = ''
  for await (const chunk of stream) raw += chunk
  try {
    const value: unknown = JSON.parse(raw)
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch { return { unparseable: raw } }
}

// Deliberately does not bind the shared launch handle to the daemon: children have their own IDs.
async function withSession<T>(payload: Record<string, unknown> | null, fn: (client: DaemonClient, session: string) => Promise<T>, timeout = REQUEST_TIMEOUT_MS): Promise<T> {
  const { workspace, session } = resolveContext(payload)
  const handle = resolveSessionHandle()
  if (!handle) throw new Error('Missing AU_MCP_SESSION; relaunch through the Arsumbris Codex launcher.')
  assertLaunchSession(session, workspace, handle)
  const transport = await connectSocket(socketPath(workspace))
  let client = createDaemonClient(transport, { requestTimeoutMs: REQUEST_TIMEOUT_MS })
  try {
    await openCodexSession(client, codexAdapterInfo(session, workspace, {
      resume: resolveResume(payload), profile: resolveProfile(),
    }), { handle })
    if (timeout !== REQUEST_TIMEOUT_MS) {
      client.dispose()
      client = createDaemonClient(transport, { requestTimeoutMs: timeout })
    }
    return await fn(client, session)
  } finally { client.dispose(); transport.close() }
}
function report(error: unknown): void {
  process.stderr.write(`au-codex: ${error instanceof Error ? error.message : String(error)}\n`)
}
export async function observeEvent(payload: Record<string, unknown> | null, kind: string, data: unknown): Promise<string | undefined> {
  try { return await withSession(payload, (client, session) => client.observe(session, traceEvent(kind, session, data))) }
  catch (error) { report(error); return undefined }
}
export function liveCaptureReady(payload: Record<string, unknown> | null): boolean {
  try {
    const { workspace, session } = resolveContext(payload)
    const handle = resolveSessionHandle()
    return !!handle && isStartupReady({ workspace, session, handle }, currentDaemonIdentity(workspace))
  } catch { return false }
}

/** Return the acknowledged prefix. Retried transcript events retain their kernel deduplication keys. */
export async function observeEvents(payload: Record<string, unknown> | null, events: ReplayEvent[]): Promise<number> {
  let acknowledged = 0
  if (!events.length) return acknowledged
  try {
    await withSession(payload, async (client, session) => {
      if (!liveCaptureReady(payload)) return
      for (const e of events) {
        await client.observe(session, traceEvent(e.kind, session, e.data, e.at, e.dedupeKey))
        acknowledged++
      }
    })
  } catch (error) { report(error) }
  return acknowledged
}
export async function sendRehydrate(payload: Record<string, unknown> | null, events: ReplayEvent[]): Promise<{ injected: number; refused: number } | undefined> {
  if (!events.length) return { injected: 0, refused: 0 }
  try { return await withSession(payload, (client, session) => client.sessionRehydrate(session, events)) }
  catch (error) { report(error); return undefined }
}
export async function reportTurnEnd(payload: Record<string, unknown> | null): Promise<void> {
  try { await withSession(payload, (client, session) => client.turnEnd(session)) } catch (error) { report(error) }
}
export async function mediateAction(payload: Record<string, unknown> | null, action: PendingAction): Promise<Decision> {
  try { return await withSession(payload, (client, session) => client.mediate(session, action), MEDIATION_TIMEOUT_MS) }
  catch (error) { report(error); return { kind: 'deny', reason: 'Arsumbris mediation could not complete. The action was blocked; restore the daemon/session connection before retrying.' } }
}
export async function sessionGuards(payload: Record<string, unknown> | null): Promise<{ denyNative: boolean }> {
  try { return await withSession(payload, (client, session) => client.sessionGuards(session)) }
  catch (error) { report(error); return { denyNative: true } }
}
export async function sessionStartContext(payload: Record<string, unknown> | null): Promise<{ inject: string[] }> {
  try { return await withSession(payload, (client, session) => client.sessionStartContext(session)) }
  catch (error) { report(error); return { inject: ['Arsumbris session initialization failed. Tell the user before attempting work; mediated native actions will be blocked until the connection is restored.'] } }
}
export function buildNativeRestrictionNote(guards: { denyNative: boolean }): string | null {
  return guards.denyNative ? 'This Arsumbris session restricts native tools. Use the au gate for actions that the native-tool policy blocks; its advertised catalogue lists the available capabilities.' : null
}
export function buildHandleMissingNote(): string {
  return 'This session is missing AU_MCP_SESSION. Tell the user that Arsumbris tools cannot function and relaunch using the Arsumbris Codex launcher.'
}
/** Generated hook registration explicitly disables Codex's context spill limit. */
export function boundedContext(text: string): string { return text }
/** Queue exactly one valid hook response before checkpointing its delivery attempt. */
export async function emitHookOutput(output: unknown): Promise<void> {
  await new Promise<void>((resolve, reject) => process.stdout.write(JSON.stringify(output), error => error ? reject(error) : resolve()))
}

/** A short complete initialization budget, including opening the daemon session. The
 * optional signal lets recovery cancel its own socket instead of leaving startup RPCs alive. */
async function startupSession<T>(payload: Record<string, unknown> | null, fn: (client: DaemonClient, session: string) => Promise<T>, signal: AbortSignal): Promise<T> {
  const { workspace, session } = resolveContext(payload)
  const handle = resolveSessionHandle()
  if (!handle) throw new Error(buildHandleMissingNote())
  assertLaunchSession(session, workspace, handle)
  signal.throwIfAborted()
  const transport = await connectSocket(socketPath(workspace))
  if (signal.aborted) { transport.close(); signal.throwIfAborted() }
  const abort = () => transport.close()
  signal.addEventListener('abort', abort, { once: true })
  const client = createDaemonClient(transport, { requestTimeoutMs: REQUEST_TIMEOUT_MS })
  try {
    await openCodexSession(client, codexAdapterInfo(session, workspace, {
      resume: resolveResume(payload), profile: resolveProfile(),
    }), { signal, handle })
    return await fn(client, session)
  } finally {
    signal.removeEventListener('abort', abort)
    // Socket close first lets the SDK reject all pending requests, including Promise.all peers.
    transport.close()
  }
}

/** Membership alone never means that the active profile instructions reached Codex. */
export async function recoverStartupContext(payload: Record<string, unknown> | null): Promise<StartupDelivery> {
  const { workspace, session } = resolveContext(payload)
  const handle = resolveSessionHandle()
  if (!handle) throw new Error(buildHandleMissingNote())
  assertLaunchSession(session, workspace, handle)
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      prepareStartupDelivery({ workspace, session, handle }, async () => startupSession(payload, async (client, thread) => {
        const [context, guards, capabilities] = await Promise.all([
          client.sessionStartContext(thread), client.sessionGuards(thread), client.listCapabilities(thread),
        ])
        const note = buildNativeRestrictionNote(guards)
        const generated = generatedStartupContext()
        return [toolStartupContext(capabilities.callables), ...(generated.trim() ? [generated] : []), ...(note ? [note] : []), ...context.inject]
      }, controller.signal), async saved => (await import('./lift.ts')).rehydrateSession(saved), controller.signal, currentDaemonIdentity(workspace)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error('Arsumbris startup recovery exceeded its eight-second budget; no work was admitted.')
          controller.abort(error)
          reject(error)
        }, REQUEST_TIMEOUT_MS)
      }),
    ])
  } finally { if (timer !== undefined) clearTimeout(timer) }
}

/** The final pre-tool observation cannot consume more than the reserved output budget. */
export async function observeToolStart(payload: Record<string, unknown>, data: unknown): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('Tool-start observation timed out')), REQUEST_TIMEOUT_MS)
  try { await startupSession(payload, (client, session) => client.observe(session, traceEvent(EventKind.ToolStart, session, data)), controller.signal) }
  catch (error) { report(error) }
  finally { clearTimeout(timer) }
}

export function preToolOutput(decision: Decision): Record<string, unknown> | undefined {
  if (decision.kind === 'deny' || decision.kind === 'ask') {
    const reason = decision.kind === 'deny' ? decision.reason : `Approval is required: ${decision.reason}. Codex cannot translate this mediator ask into an approval. Use a mediator that resolves requestApproval before retrying.`
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason.trim() || 'Arsumbris denied this action.' } }
  }
  const text = decision.kind === 'inject' ? decision.text : decision.note
  if (!text) return undefined
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: boundedContext(text) } }
}
export async function closeSession(payload: Record<string, unknown> | null): Promise<void> {
  try { await withSession(payload, (client, session) => client.sessionClose(session)) } catch (error) { report(error) }
}

/** Codex SessionEnd is forcibly capped at three seconds. Use the already-open raw thread:
 * no sessionOpen, no reconnect/retry, and reserve time for the end event and close. The
 * executable also has an absolute watchdog for a socket connect that never settles. */
export async function finishSession(
  payload: Record<string, unknown> | null,
  events: ReplayEvent[],
  deadline: number,
): Promise<number> {
  let acknowledged = 0
  try {
    const { workspace, session } = resolveContext(payload)
    const handle = resolveSessionHandle()
    if (!handle) throw new Error('Missing AU_MCP_SESSION')
    const generation = registrationGeneration(session, workspace, handle)
    await withThreadLock(session, async () => {
      if (registrationGeneration(session, workspace, handle) !== generation) return
      const transport = await connectSocket(socketPath(workspace))
      const client = createDaemonClient(transport, { requestTimeoutMs: 350 })
      try {
        for (const event of liveCaptureReady(payload) ? events : []) {
          if (Date.now() > deadline - 1100) break
          try {
            await client.observe(session, traceEvent(event.kind, session, event.data, event.at, event.dedupeKey))
            acknowledged++
          } catch (error) { report(error); break }
        }
        if (Date.now() < deadline - 750) {
          try { await client.observe(session, traceEvent(EventKind.SessionEnd, session, { reason: payload?.reason ?? null })) }
          catch (error) { report(error) }
        }
        if (Date.now() < deadline - 400) {
          // SessionEnd identifies one conversation, not the process or a proven child subtree.
          // Registration shares this lock, so a resume cannot race the daemon close or local write.
          try {
            await client.sessionClose(session)
            markLaunchSessionClosed(session, workspace, handle)
          } catch (error) { report(`Thread ${session} shutdown was not acknowledged: ${String(error)}`) }
        } else { report('Shutdown budget expired; the ending thread may remain open.') }
      } finally { client.dispose(); transport.close() }
    }, deadline - 350)
  } catch (error) { report(error) }
  return acknowledged
}
