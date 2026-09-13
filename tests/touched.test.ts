import { describe, it, expect } from 'vitest'
import { pinnedFileTarget, commitReferent } from '@arsumbris/au-mcp-sdk'
import { extractTouch } from '../src/touched.ts'

// Codex delivers an MCP tool result to the hook as the full CallToolResult `{ content: [{type,text}] }`
// (mcpResult). extractTouch stays transport-tolerant: it also accepts a bare content array (mcpText).
const mcpText = (text: string) => [{ type: 'text', text }]
const mcpResult = (text: string) => ({ content: [{ type: 'text', text }] })

describe('extractTouch', () => {
  it('lifts a mutation touch (path + commit) from the gate result', () => {
    const response = mcpText(JSON.stringify({ message: 'wrote /abs/note.md (hash h1)', touched: { path: 'note.md', commit: 'c0ffee' } }))
    const touch = extractTouch(response)
    expect(touch).toEqual({ path: 'note.md', commit: 'c0ffee' })
    expect(pinnedFileTarget(touch)).toBe('[[note.md::@c0ffee]]')
  })

  it('lifts an unpinned touch (no commit, non-git repo) but yields no target', () => {
    const response = mcpText(JSON.stringify({ message: 'wrote /abs/note.md', touched: { path: 'note.md' } }))
    const touch = extractTouch(response)
    expect(touch).toEqual({ path: 'note.md' })
    expect(pinnedFileTarget(touch)).toBeNull() // unpinned -> no value (would fail file*@)
  })

  it('returns null for a read result (numbered text, not JSON)', () => {
    expect(extractTouch(mcpText('     1\t# Title\n     2\tbody'))).toBeNull()
  })

  it('returns null for an error string and for empty/malformed shapes', () => {
    expect(extractTouch(mcpText('Error: old_string not found'))).toBeNull()
    expect(extractTouch(mcpText('{ not json'))).toBeNull()
    expect(extractTouch(mcpText(JSON.stringify({ message: 'no touch here' })))).toBeNull()
    expect(extractTouch(null)).toBeNull()
    expect(extractTouch([])).toBeNull()
  })

  it('accepts a bare JSON string response too (transport-tolerant)', () => {
    expect(extractTouch(JSON.stringify({ touched: { path: 'a/b.md', commit: 'abc' } }))).toEqual({ path: 'a/b.md', commit: 'abc' })
  })

  // Regression: MCP results arrive wrapped in CallToolResult.content.
  it("lifts the touch from Codex's { content: [...] } CallToolResult wrapper", () => {
    const response = mcpResult(
      JSON.stringify({
        message: 'wrote /workspace/note.md (hash 0123456789abcdef)',
        touched: { path: 'note.md', commit: '0123456789abcdef0123456789abcdef01234567' },
      }),
    )
    const touch = extractTouch(response)
    expect(touch).toEqual({ path: 'note.md', commit: '0123456789abcdef0123456789abcdef01234567' })
    expect(pinnedFileTarget(touch)).toBe('[[note.md::@0123456789abcdef0123456789abcdef01234567]]')
  })

  it('still returns null for a read / error delivered in the { content: [...] } wrapper', () => {
    expect(extractTouch(mcpResult('     1\t# Title'))).toBeNull()
    expect(extractTouch(mcpResult('Error: old_string not found'))).toBeNull()
  })
})

describe('modern mutation provenance', () => {
  it('preserves delete last-live pin and separately attributes deletion commit', () => {
    const touch = extractTouch(mcpResult(JSON.stringify({ touched: { path: 'gone.md', access: 'delete', priorCommit: 'before', commit: 'deletion' } })))
    expect(touch?.access).toBe('delete')
    expect(pinnedFileTarget(touch)).toBe('[[gone.md::@before]]')
    expect(commitReferent(touch?.commit)).toBe('[[::@deletion]]')
  })
  it('preserves rename source and destination pin', () => {
    const touch = extractTouch(mcpResult(JSON.stringify({ touched: { path: 'new.md', from: 'old.md', access: 'rename', commit: 'renamed' } })))
    expect(touch).toMatchObject({ from: 'old.md', access: 'rename' })
    expect(pinnedFileTarget(touch)).toBe('[[new.md::@renamed]]')
  })
})
