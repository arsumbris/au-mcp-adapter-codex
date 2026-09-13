import { describe, it, expect } from 'vitest'
import type { PluginManifest } from '@arsumbris/au-mcp-sdk'
import { buildTools, toolName, provenanceNote, toolCatalogue, toolStartupContext } from '../src/advertise.ts'

const manifest = (
  id: string,
  extra: { description?: string; guidance?: string; inputSchema?: Record<string, unknown>; provenance?: string } = {},
): PluginManifest => ({
  id,
  name: id,
  ...(extra.description ? { description: extra.description } : {}),
  ...(extra.guidance ? { guidance: extra.guidance } : {}),
  ...(extra.inputSchema ? { inputSchema: extra.inputSchema } : {}),
  ...(extra.provenance ? { provenance: extra.provenance } : {}),
  contractVersion: 0,
  kind: 'tool',
})

const readFileSchema = {
  type: 'object',
  properties: { file_path: { type: 'string' } },
  required: ['file_path'],
  additionalProperties: false,
}

describe('MCP tool advertisement', () => {
  it('maps a plugin id to the agent-facing tool name', () => {
    expect(toolName('mcp.read_file')).toBe('read_file')
    expect(toolName('mcp.au_types')).toBe('au_types')
  })

  it('FORWARDS both the description AND the inputSchema off the manifest (owned by the tool def, not the adapter)', () => {
    const tools = buildTools([
      manifest('mcp.read_file', { description: 'Read a file from disk.', inputSchema: readFileSchema }),
      manifest('mcp.au_guide', { inputSchema: { type: 'object', properties: { scenario: { type: 'string' } }, additionalProperties: false } }),
    ])
    const read = tools.find((t) => t.name === 'read_file')!
    expect(read.description).toBe('Read a file from disk.')
    expect(read.inputSchema).toMatchObject(readFileSchema)
    expect(tools.find((t) => t.name === 'au_guide')!.inputSchema).toMatchObject({ properties: { scenario: { type: 'string' } } })
  })

  it('falls back to the name when the manifest has no description', () => {
    const [tool] = buildTools([manifest('mcp.read_file')])
    expect(tool.description).toBe('mcp.read_file') // manifest.name fallback
  })

  it('falls back to an empty-argument schema when the manifest carries no inputSchema', () => {
    const [tool] = buildTools([manifest('mcp.mystery')])
    expect(tool.name).toBe('mystery')
    expect(tool.inputSchema).toMatchObject({ type: 'object', properties: {}, additionalProperties: false })
  })
})

describe('tool catalogue (startup instructions)', () => {
  const tools = buildTools([
    manifest('mcp.read_file', { description: 'Read a file from disk.' }),
    manifest('mcp.au_types', { description: 'List the types defined in the workspace.' }),
  ])

  it('lists tool NAMES only — descriptions are NOT restated (they ride tools/list)', () => {
    const cat = toolCatalogue(tools)
    expect(cat).toContain('- read_file')
    expect(cat).toContain('- au_types')
    expect(cat).toContain('The 2 tools available to you in this session')
    // The per-tool descriptions must not be duplicated into the instructions blob.
    expect(cat).not.toContain('Read a file from disk.')
    expect(cat).not.toContain('List the types defined in the workspace.')
  })

  it('delivers shared orientation separately from tool descriptions', () => {
    const selected = [manifest('mcp.read_file', { description: 'Read a file.', guidance: 'Read before editing.', provenance: 'tool-fixture' })]
    const context = toolStartupContext(selected)
    expect(context).toContain('The 1 tools available')
    expect(context).toContain('read_file (from tool-fixture)')
    expect(context).not.toContain('Read before editing.')
    expect(buildTools(selected)[0].description).toBe('Read a file.\n\nRead before editing.')
  })

  it('reports the daemon-down case when no tools are advertised', () => {
    expect(toolCatalogue([])).toContain('No tools are available in this session')
  })
})

describe('tool provenance note (core vs contributed)', () => {
  it('groups contributed tools by their package repo, generated from manifest provenance', () => {
    const note = provenanceNote([
      manifest('mcp.au_types', { provenance: 'core' }),
      manifest('mcp.read_file', { provenance: 'core' }),
      manifest('mcp.au_guide', { provenance: 'tool-fixture' }),
      manifest('mcp.dry_run_type', { provenance: 'tool-fixture' }),
    ])
    expect(note).toContain('CONTRIBUTED by mounted capability packages:')
    expect(note).toContain('au_guide, dry_run_type (from tool-fixture)')
    expect(note).not.toContain('au_types') // core tools are not listed as contributed
  })

  it('says everything is core when no package contributes a tool', () => {
    const note = provenanceNote([manifest('mcp.au_types', { provenance: 'core' }), manifest('mcp.read_file')])
    expect(note).toContain('every tool here is CORE')
    expect(note).not.toContain('CONTRIBUTED')
  })
})
