// Recover assistant text, exposed reasoning, and native failures from Codex rollouts.
// The kernel deduplicates stable event keys; the read cursor only avoids repeated transcript IO.
// Resume replays history inertly before live capture can resume.

import { readFileSync, existsSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { extractToolFailed, type PendingTools } from './failed-tools.ts'
import { readLiftTail, sweepCursors } from './lift-cursor.ts'
import { codexHookToolName } from './canonical-tools.ts'
import { EventKind, type MessageBlock, type ReplayEvent } from '@arsumbris/au-mcp-sdk'
import { resolveContext, observeEvents, sendRehydrate, agentFields, reportTurnEnd, finishSession, liveCaptureReady } from './bridge.ts'

/** A rollout envelope line: { timestamp, type, payload }. */
interface RolloutLine {
  timestamp?: string
  type?: string
  payload?: ResponseItemPayload
}
/** The `response_item` payload we care about (a Responses-API item). */
interface ResponseItemPayload {
  type?: string
  role?: string
  id?: string
  content?: Array<{ type?: string; text?: unknown }>
  summary?: Array<{ text?: unknown }>
}

/** Content fallback identity when the native item has no id. */
function hash(s: string): string { return createHash('sha256').update(s).digest('hex') }

/** Assistant message text: join the `output_text` blocks (ignores user/developer `input_text`). */
function assistantText(content: ResponseItemPayload['content']): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((c) => c?.type === 'output_text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('')
    .trim()
}

/** Capture only explicitly exposed text. Encrypted-only reasoning contributes no fabricated content. */
function reasoningText(p: ResponseItemPayload): string {
  const texts = (arr: Array<{ text?: unknown }> | undefined): string =>
    Array.isArray(arr) ? arr.map((x) => (typeof x?.text === 'string' ? x.text : '')).filter(Boolean).join('\n') : ''
  return [texts(p.summary), texts(p.content)].filter(Boolean).join('\n\n').trim()
}

export interface LiftResult {
  events: ReplayEvent[]
  pending: PendingTools
}

/** Native item IDs, or timestamp/content signatures, are shared by live capture and replay. */
function extractAssistantItems(rolloutText: string): ReplayEvent[] {
  const lifted: ReplayEvent[] = []

  for (const raw of rolloutText.split('\n')) {
    const line = raw.trim()
    if (!line || line[0] !== '{') continue // JSONL: skip blanks + any non-object (e.g. zstd garbage)
    let env: RolloutLine
    try {
      env = JSON.parse(line) as RolloutLine
    } catch {
      continue // a partial final line mid-write: re-tried on the next rescan
    }
    if (env.type !== 'response_item' || !env.payload) continue
    const p = env.payload
    const at = typeof env.timestamp === 'string' ? env.timestamp : undefined

    let block: MessageBlock | null = null
    let mark = ''
    if (p.type === 'message' && p.role === 'assistant') {
      const text = assistantText(p.content)
      if (text) {
        block = { kind: 'text', text }
        mark = 'a'
      }
    } else if (p.type === 'reasoning') {
      const text = reasoningText(p)
      if (text) {
        block = { kind: 'thinking', text }
        mark = 'r'
      }
    }
    if (!block) continue // not an assistant message/reasoning, or no plaintext (encrypted reasoning)

    const key = p.id ?? `${mark}:${hash(`${at ?? ''}:${block.text}`)}`
    lifted.push({ kind: EventKind.AssistantMessage, data: { uuid: key, blocks: [block] }, at, dedupeKey: key })
  }

  return lifted
}

/** Combine exposed assistant items and authoritative native failures. Successful completed
 * calls remain hook-owned. Authored timestamps retain source chronology within this batch. */
export function extractLifted(text: string, pending: PendingTools = {}): LiftResult {
  const failures = extractToolFailed(text, pending)
  const events = [...extractAssistantItems(text), ...failures.events]
  return {
    events: [...new Map(events.map(event => [event.dedupeKey, event])).values()].sort((a, b) => (a.at ?? '').localeCompare(b.at ?? '')),
    pending: failures.pending,
  }
}

// --- Acknowledged capture and inert resume replay ------------------------------------

/** A compressed rollout is a supported Codex persistence format, not empty conversation. */
export function readRollout(path: string): string {
  const bytes = readFileSync(path)
  return path.endsWith('.zst') ? zstdDecompressSync(bytes).toString('utf8') : bytes.toString('utf8')
}
export function rolloutPathFor(payload: Record<string, unknown> | null): string | undefined {
  // SubagentStop keeps the root session_id; agent_id identifies the child and agent_transcript_path its rollout.
  const p = payload?.hook_event_name === 'SubagentStop' ? payload.agent_transcript_path : payload?.transcript_path
  return typeof p === 'string' && p && existsSync(p) ? p : undefined
}
/** Observable response items only. Raw user-role messages can be injected environment context;
 * use Codex's user_message event for the actual prompt instead. Tool outcomes are replayed only
 * when there is an explicit matching output, never invent success for an interrupted call. */
export function extractObservable(text: string): ReplayEvent[] {
  const out: ReplayEvent[] = []
  const calls = new Map<string, { name?: unknown; namespace?: unknown; arguments?: unknown; input?: unknown }>()
  const failures = new Map(extractToolFailed(text).events.map(event => [event.data.uuid, event]))
  const seen = new Set<string>()
  for (const line of text.split('\n')) {
    let env: { type?: string; timestamp?: string; payload?: Record<string, unknown> }
    try { env = JSON.parse(line) } catch { continue }
    const p = env.payload
    if (!p) continue
    for (const event of extractLifted(line).events) {
      if (event.dedupeKey && seen.has(event.dedupeKey)) continue
      if (event.dedupeKey) seen.add(event.dedupeKey)
      out.push(event.kind === EventKind.ToolFailed ? failures.get(event.dedupeKey!) ?? event : event)
    }
    if (env.type === 'event_msg' && p.type === 'user_message' && typeof p.message === 'string') {
      out.push({ kind: EventKind.UserPrompt, data: { prompt: p.message }, at: env.timestamp })
    }
    if (env.type !== 'response_item' || typeof p.call_id !== 'string') continue
    if (p.type === 'function_call' || p.type === 'custom_tool_call') calls.set(p.call_id, p)
    else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      const call = calls.get(p.call_id)
      if (!call) continue
      let input = call.arguments ?? call.input ?? null
      if (typeof input === 'string') { try { input = JSON.parse(input) } catch { /* custom tool text */ } }
      out.push({ kind: EventKind.ToolCall, data: { tool: codexHookToolName(call.name, call.namespace), input, tool_use_id: p.call_id, response: p.output ?? null }, at: env.timestamp })
      calls.delete(p.call_id)
    }
  }
  return out
}
/** True only after the whole observable replay is acknowledged. */
export async function rehydrateSession(payload: Record<string, unknown> | null): Promise<boolean> {
  try {
    const path = rolloutPathFor(payload)
    if (!path) return false
    const events = extractObservable(readRollout(path))
    if (!events.length) return true
    const acknowledged = await sendRehydrate(payload, events)
    return acknowledged !== undefined && acknowledged.refused === 0 && acknowledged.injected === events.length
  } catch (error) {
    process.stderr.write(`au-codex resume capture: ${String(error)}\n`)
    return false
  }
}

function captureBatch(payload: Record<string, unknown> | null, maxBytes = Infinity) {
  const path = rolloutPathFor(payload)
  if (!path || !liveCaptureReady(payload)) return undefined
  const { workspace, session } = resolveContext(payload)
  if (path.endsWith('.zst')) {
    if (maxBytes !== Infinity) return undefined
    return { events: extractLifted(readRollout(path)).events, save() {} }
  }
  const tail = readLiftTail(path, workspace, session, maxBytes)
  const complete = extractLifted(tail.complete, tail.pending)
  const trailing = extractLifted(tail.trailing, complete.pending)
  return { events: [...complete.events, ...trailing.events], save: () => tail.save(complete.pending) }
}

export async function liftRollout(payload: Record<string, unknown> | null): Promise<void> {
  try {
    const batch = captureBatch(payload)
    if (!batch) return
    const events = batch.events.map(event => ({ ...event, data: { ...(event.data as object), ...agentFields(payload) } }))
    if (await observeEvents(payload, events) === events.length) batch.save()
  } catch (error) { process.stderr.write(`au-codex transcript capture: ${String(error)}\n`) }
}

/** SubagentStop ends a child turn; the child remains in the same daemon run. */
export async function completeSubagentTurn(payload: Record<string, unknown> | null): Promise<void> {
  await liftRollout({ ...payload, transcript_path: payload?.agent_transcript_path })
  await reportTurnEnd(payload)
}

/** Bounded final tail and close within Codex's three-second SessionEnd budget. */
export async function finalizeSession(payload: Record<string, unknown> | null, deadline: number): Promise<void> {
  let batch: ReturnType<typeof captureBatch>
  try {
    if (Date.now() < deadline - 1700) batch = captureBatch(payload, 2_000_000)
  } catch (error) { process.stderr.write(`au-codex final capture: ${String(error)}\n`) }
  try {
    const events = batch?.events.map(event => ({ ...event, data: { ...(event.data as object), ...agentFields(payload) } })) ?? []
    if (await finishSession(payload, events, deadline) === events.length) batch?.save()
  } finally { sweepCursors(deadline) }
}
