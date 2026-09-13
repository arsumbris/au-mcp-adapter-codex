// Build tool descriptors and session guidance from daemon manifests.

import type { PluginManifest, ToolManifest } from '@arsumbris/au-mcp-sdk'

export interface McpToolDescriptor {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** Empty-argument fallback when the manifest has no schema. */
const EMPTY_SCHEMA: Record<string, unknown> = { type: 'object', properties: {}, additionalProperties: false }

/** The agent-facing tool name for a plugin id (`mcp.read_file` -> `read_file`). */
export const toolName = (id: string): string => id.replace(/^mcp\./, '')

/** Describe tool provenance from the selected manifests. */
export function provenanceNote(callables: PluginManifest[]): string {
  const contributed = new Map<string, string[]>() // repo -> agent-facing tool names
  for (const m of callables) {
    if (!m.provenance || m.provenance === 'core') continue
    contributed.set(m.provenance, [...(contributed.get(m.provenance) ?? []), toolName(m.id)])
  }
  if (contributed.size === 0) {
    return '\nTool provenance: every tool here is CORE, built into the gate by the arsumbris engine. No capability packages contribute tools in this workspace.'
  }
  const groups = [...contributed].map(([repo, names]) => `${names.sort().join(', ')} (from ${repo})`).join('; ')
  return `\nTool provenance: tools not named here are CORE, built into the gate by the arsumbris engine. CONTRIBUTED by mounted capability packages: ${groups}. A contributed tool comes from an installed package (not the engine itself) and is advertised because that package is mounted in this workspace.`
}

/** List selected tool names once in startup context; descriptions ride tools/list. */
export function toolCatalogue(tools: McpToolDescriptor[]): string {
  if (tools.length === 0) {
    return '\nNo tools are available in this session. If you expected some, the au-mcp daemon may not be running for this workspace.'
  }
  const lines = tools.map((t) => `- ${t.name}`).join('\n')
  return `\nThe ${tools.length} tools available to you in this session (each tool carries its own description):\n${lines}`
}

const FRAMING = `The "au" server provides this workspace's governed Arsumbris tools. Prefer its engine tools for typed knowledge, provenance, and structured reads and writes. Paths are absolute.
The initial catalogue below reflects this launch's selected tools. tools/list is authoritative if the daemon reconnects or its capabilities change.`

/** Shared orientation belongs in startup context, not MCP server instructions. */
export function toolStartupContext(callables: PluginManifest[]): string {
  return FRAMING + toolCatalogue(buildTools(callables)) + provenanceNote(callables)
}

/** Build MCP tool descriptors from the daemon's advertised callables. */
export function buildTools(callables: PluginManifest[]): McpToolDescriptor[] {
  return callables
    .filter((m): m is ToolManifest => m.kind === 'tool')
    .map((manifest) => ({
      name: toolName(manifest.id),
      description: [manifest.description ?? manifest.name, manifest.guidance].filter(Boolean).join('\n\n'),
      inputSchema: manifest.inputSchema ?? EMPTY_SCHEMA,
    }))
}
