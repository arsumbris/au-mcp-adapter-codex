import { describe, it, expect } from 'vitest'
import type { Skill } from '@arsumbris/au-mcp'

import { codexSkillTransform } from '../src/skills-codex.ts'

const skill = (over: Partial<Skill> = {}): Skill => ({
  path: '/ws/pkg/shout-skill.md',
  owner: 'tool-fixture',
  name: 'shout-helper',
  description: 'When the user wants text SHOUTED.',
  relatedTools: [],
  allowedTools: [],
  body: '# When to use\n\nThe user asks to shout.\n',
  ...over,
})

/** The file map, so a test can assert one file's content by its relative path. */
const filesOf = (skills: Skill[]): Map<string, string> =>
  new Map(codexSkillTransform(skills).files.map((f) => [f.relPath, f.content]))

describe('codexSkillTransform', () => {
  it('writes a single-owner skill to skills/<name>/SKILL.md with a clean name', () => {
    const tree = codexSkillTransform([skill()])
    expect(tree.pluginRoots).toEqual(['skills'])
    expect(tree.files.map((f) => f.relPath)).toEqual(['skills/shout-helper/SKILL.md'])
  })

  it('maps name + description into the frontmatter and keeps the body verbatim', () => {
    const md = filesOf([skill()]).get('skills/shout-helper/SKILL.md')!
    expect(md).toBe(
      '---\nname: shout-helper\ndescription: When the user wants text SHOUTED.\n---\n\n' +
        '# When to use\n\nThe user asks to shout.\n',
    )
  })

  it('materializes allowed-tools as a YAML list of Codex tool names', () => {
    const md = filesOf([skill({ allowedTools: ['mcp.tool.shout', 'mcp.tool.read_file'] })]).get(
      'skills/shout-helper/SKILL.md',
    )!
    expect(md).toContain('allowed-tools: [mcp__au__shout, mcp__au__read_file]')
  })

  it('omits allowed-tools when the skill declares none (an empty key would mean "allow nothing")', () => {
    expect(filesOf([skill({ allowedTools: [] })]).get('skills/shout-helper/SKILL.md')!).not.toContain('allowed-tools')
  })

  it('does NOT materialize related-tools (the discovery axis, graph-only)', () => {
    const md = filesOf([skill({ relatedTools: ['mcp.tool.shout'], allowedTools: [] })]).get(
      'skills/shout-helper/SKILL.md',
    )!
    expect(md).not.toContain('related-tools')
  })

  it('groups multiple owners into ONE flat skills tree, sorted; unique names stay clean', () => {
    const tree = codexSkillTransform([
      skill({ owner: 'host-fixture', name: 'orchestrate' }),
      skill({ owner: 'tool-fixture', name: 'shout-helper' }),
      skill({ owner: 'host-fixture', name: 'inspect' }),
    ])
    expect(tree.pluginRoots).toEqual(['skills'])
    expect(tree.files.map((f) => f.relPath)).toEqual([
      'skills/inspect/SKILL.md',
      'skills/orchestrate/SKILL.md',
      'skills/shout-helper/SKILL.md',
    ])
  })

  it('disambiguates shared skill names by owner', () => {
    const paths = codexSkillTransform([
      skill({ owner: 'style-fixture', name: 'check' }),
      skill({ owner: 'rules-fixture', name: 'check' }),
      skill({ owner: 'host-fixture', name: 'orchestrate' }),
    ]).files.map((f) => f.relPath)
    expect(paths).toHaveLength(3)
    expect(paths).toContain('skills/rules-fixture-check/SKILL.md')
    expect(paths).toContain('skills/style-fixture-check/SKILL.md')
    expect(paths).toContain('skills/orchestrate/SKILL.md')
    const md = filesOf([skill({ owner: 'rules-fixture', name: 'check' }), skill({ owner: 'style-fixture', name: 'check' })]).get(
      'skills/rules-fixture-check/SKILL.md',
    )!
    expect(md).toContain('name: rules-fixture-check')
  })

  it('quotes a description that would otherwise break the YAML frontmatter', () => {
    const md = filesOf([skill({ description: 'Use this: when the user asks for X' })]).get(
      'skills/shout-helper/SKILL.md',
    )!
    expect(md).toContain('description: "Use this: when the user asks for X"')
    const frontmatter = md.split('---')[1]
    expect(frontmatter.split('\n').filter((l) => l.trim()).length).toBe(2) // name + description (no allowed-tools here)
  })

  it('an empty skill set yields no files and no plugin roots', () => {
    expect(codexSkillTransform([])).toEqual({ files: [], pluginRoots: [] })
  })

  it('is PURE — same input, same output', () => {
    const input = [skill()]
    expect(codexSkillTransform(input)).toEqual(codexSkillTransform(input))
  })
  it('prevents a clean name from clobbering an owner-prefixed collision', () => {
    const input = [skill({owner:'a',name:'check'}),skill({owner:'b',name:'check'}),skill({owner:'c',name:'a-check'})]
    const first = codexSkillTransform(input)
    expect(new Set(first.files.map(f=>f.relPath)).size).toBe(3)
    expect(codexSkillTransform([...input].reverse())).toEqual(first)
  })
  it('rejects paths that escape the generated skill root', () => {
    expect(()=>codexSkillTransform([skill({name:'../escape'})])).toThrow('Invalid Codex skill identity')
  })
  it('quotes a description that YAML would parse as a boolean', () => {
    expect(codexSkillTransform([skill({description:'true'})]).files[0].content).toContain('description: "true"')
  })

})
