import { afterEach, beforeEach, expect, it } from 'vitest'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readLiftTail, sweepCursors } from '../src/lift-cursor.ts'
import { adapterDeviceDir } from '../src/launch-env.ts'
import { extractToolFailed } from '../src/failed-tools.ts'
let workspace: string
const cache = () => join(adapterDeviceDir(), 'lift')
beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'au-cursor-'))
  rmSync(cache(), { recursive: true, force: true })
})
afterEach(() => rmSync(workspace, { recursive: true, force: true }))
const transcript = (text: string) => { const path = join(workspace, 'rollout.jsonl'); writeFileSync(path, text); return path }

it('reads only new bytes after an acknowledged multibyte prefix', () => {
  const path = transcript('café ☕\n')
  const first = readLiftTail(path, workspace, 'thread')
  expect(first.complete).toBe('café ☕\n')
  first.save({})
  appendFileSync(path, 'next\n')
  expect(readLiftTail(path, workspace, 'thread').complete).toBe('next\n')
  expect(readLiftTail(path, workspace, 'other-thread').complete).toBe('café ☕\nnext\n')
})

it('rereads an unterminated record while preserving pending data at the saved boundary', () => {
  const path = transcript('complete\n{"partial":')
  const first = readLiftTail(path, workspace, 'thread')
  expect(first.trailing).toBe('{"partial":')
  first.save({ call: { cmd: 'original' } })
  appendFileSync(path, 'true}\nnext\n')
  const next = readLiftTail(path, workspace, 'thread')
  expect(next.complete).toBe('{"partial":true}\nnext\n')
  expect(next.pending).toEqual({ call: { cmd: 'original' } })
})

it('resets after replacement even when the new file is larger, and after truncation', () => {
  const path = transcript('first\n')
  readLiftTail(path, workspace, 'thread').save({ old: true })
  const replacement = join(workspace, 'replacement')
  writeFileSync(replacement, 'replacement is longer\n'); renameSync(replacement, path)
  const replaced = readLiftTail(path, workspace, 'thread')
  expect(replaced.complete).toBe('replacement is longer\n')
  expect(replaced.pending).toEqual({})
  replaced.save({ old: true })
  writeFileSync(path, 'x\n')
  const truncated = readLiftTail(path, workspace, 'thread')
  expect(truncated.complete).toBe('x\n')
  expect(truncated.pending).toEqual({})
})

it('falls back to a full read for a corrupt cursor and bounds final reads by bytes', () => {
  const path = transcript('first\nsecond\n')
  readLiftTail(path, workspace, 'thread').save({})
  writeFileSync(join(cache(), readdirSync(cache())[0]), '{broken')
  expect(readLiftTail(path, workspace, 'thread', 6).complete).toBe('first\n')
})

it('sweeps only expired cursors and leaves recent cursors and unrelated files intact', () => {
  const path = transcript('line\n')
  readLiftTail(path, workspace, 'old').save({})
  const old = join(cache(), readdirSync(cache())[0])
  const then = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
  utimesSync(old, then, then)
  readLiftTail(path, workspace, 'recent').save({})
  writeFileSync(join(cache(), 'unrelated.lock'), 'keep')
  sweepCursors()
  expect(existsSync(old)).toBe(false)
  expect(readdirSync(cache())).toHaveLength(2)
  expect(readFileSync(join(cache(), 'unrelated.lock'), 'utf8')).toBe('keep')
})

it('retains original native tool input until the completion record arrives', () => {
  const line = (type: string, payload: unknown) => JSON.stringify({ type, payload })
  const started = extractToolFailed(line('response_item', { type: 'function_call', name: 'exec_command', call_id: 'call', arguments: '{"cmd":"exit 7"}' }))
  const output = extractToolFailed(line('response_item', { type: 'function_call_output', call_id: 'call', output: 'exit 7' }), started.pending)
  const completed = extractToolFailed(line('event_msg', { type: 'item_completed', item: { type: 'CommandExecution', id: 'call', status: 'failed', exit_code: 7 } }), output.pending)
  expect(completed.events[0]).toMatchObject({ dedupeKey: 'failure:call', data: { input: { cmd: 'exit 7' }, exit_code: 7 } })
  expect(completed.pending).toEqual({})
  const success = extractToolFailed(line('event_msg', { type: 'item_completed', item: { type: 'CommandExecution', id: 'call', status: 'completed' } }), started.pending)
  expect(success.events).toEqual([])
  expect(success.pending).toEqual({})
})
