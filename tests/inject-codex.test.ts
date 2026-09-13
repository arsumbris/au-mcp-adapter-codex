import { describe, it, expect } from 'vitest'
import type { InjectBlock } from '@arsumbris/au-mcp'

import { codexInjectTransform, renderInjectTree } from '../src/inject-codex.ts'

// The shared materializer supplies expanded blocks to the adapter.
const block = (over: Partial<InjectBlock> = {}): InjectBlock => ({
  key: 'fixture-workspace:orientation',
  stem: 'orientation',
  repo: 'fixture-workspace',
  body: '# Orientation\n\nThis is the fixture workspace.\n',
  ...over,
})

const named = (n: string): InjectBlock => block({ key: `fixture-workspace:${n}`, stem: n })

const filesOf = (tree: { files: { relPath: string; content: string }[] }): Map<string, string> =>
  new Map(tree.files.map((f) => [f.relPath, f.content]))

const CONTENT = 'inject/content.md'

describe('codexInjectTransform / renderInjectTree', () => {
  it('empty in, empty out (no file, nothing dropped)', () => {
    expect(codexInjectTransform([])).toEqual({ files: [], pluginRoots: [], dropped: [] })
  })

  it('emits ONE inject content file with the block in an addressed envelope', () => {
    const tree = codexInjectTransform([block()])
    expect(tree.pluginRoots).toEqual(['inject'])
    expect(tree.dropped).toEqual([])
    expect(tree.files.map((f) => f.relPath)).toEqual([CONTENT])
    const content = filesOf(tree).get(CONTENT) ?? ''
    expect(content).toContain('<injected file [[orientation::fixture-workspace]]>')
    expect(content).toContain('</injected file [[orientation::fixture-workspace]]>')
    expect(content).toContain('# Orientation')
    expect(content).not.toContain('type: mcp.inject') // body already frontmatter-stripped
  })

  it('PACKS several small blocks into the SINGLE content file (explicit bounded context delivery)', () => {
    const blocks = [named('a'), named('b'), named('c')]
    const tree = renderInjectTree(blocks, { budget: 30000 })
    expect(tree.files.map((f) => f.relPath)).toEqual([CONTENT]) // still ONE file
    expect(tree.dropped).toEqual([])
    const content = filesOf(tree).get(CONTENT) ?? ''
    for (const a of ['[[a::fixture-workspace]]', '[[b::fixture-workspace]]', '[[c::fixture-workspace]]']) {
      expect(content).toContain(a)
    }
    expect(content).not.toContain('budget-overflow')
  })

  it('bounds large Unicode content and reports every dropped block', () => {
    const blocks = Array.from({length: 30}, (_, i) => block({key:`repo:${i}`,stem:`node-${i}`,body:'🌳'.repeat(200)}))
    const tree = renderInjectTree(blocks, { budget: 3000 })
    expect(Buffer.byteLength(tree.files[0].content)).toBeLessThanOrEqual(3000)
    expect(tree.files[0].content).toContain('NOT injected')
    expect(tree.dropped.length).toBeGreaterThan(0)
    for (const dropped of tree.dropped) expect(tree.files[0].content).not.toContain(`<injected file ${dropped.addr}>`)
  })

  it('bounds overflow notices even when thousands of addresses are dropped', () => {
    const blocks = Array.from({length: 2000}, (_, i) => block({key:`repo:${i}`,stem:'x'.repeat(200),body:'x'.repeat(2000)}))
    const tree = renderInjectTree(blocks, {budget: 512})
    expect(tree.dropped).toHaveLength(2000)
    expect(Buffer.byteLength(tree.files[0].content)).toBeLessThanOrEqual(512)
  })

  it('preserves the beginning, middle, and end of a large selected block', () => {
    const tree = codexInjectTransform([block({body:'FIRST'+ '🌳'.repeat(35000)+'MIDDLE'+'🌳'.repeat(35000)+'LAST'})])
    expect(tree.dropped).toEqual([])
    expect(tree.files[0].content).toContain('FIRST')
    expect(tree.files[0].content).toContain('MIDDLE')
    expect(tree.files[0].content).toContain('LAST')
  })

  it('rejects invalid explicit budgets', () => {
    for (const budget of [0, -1, 255, 1.5, Infinity, NaN]) expect(() => renderInjectTree([block()], {budget})).toThrow(/256 bytes/)
  })

  it('no overflow notice when nothing is dropped', () => {
    const content = filesOf(codexInjectTransform([block()])).get(CONTENT) ?? ''
    expect(content).not.toContain('budget-overflow')
  })

  it('is PURE — same input, same output', () => {
    const input = [block()]
    expect(codexInjectTransform(input)).toEqual(codexInjectTransform(input))
  })
})
