import { codexResumeRef } from './resume-ref.ts'
// Codex 0.153.2 canonical hook tool names; match aliases are not payload identities.
import type { AdapterInfo, NativeTool } from '@arsumbris/au-mcp-sdk'

export const MCP_SERVER_NAME = 'au'
export const GATE_PREFIX = `mcp__${MCP_SERVER_NAME}__`
export const CODEX_NATIVE_TOOLS: NativeTool[] = [
  { name: 'apply_patch', gateEquivalent: `${GATE_PREFIX}edit_file` },
  { name: 'Bash', gateEquivalent: `${GATE_PREFIX}bash` },
  { name: 'spawn_agent' },
]
/** Shell commands have unknown access; only apply_patch guarantees file mutation. */
export const CODEX_FILE_ACCESS: Record<string, 'read' | 'write'> = { apply_patch: 'write' }
export interface CodexSessionOptions {
  resume?: boolean
  profile?: string
}
/** Raw Codex thread IDs route daemon calls. Never bind siblings to a shared launch handle. */
export function codexAdapterInfo(session: string, workspace: string, options: CodexSessionOptions = {}): AdapterInfo {
  return {
    harness: 'mcp.adapter.codex', session, workspace, resumeRef: codexResumeRef(session), nativeTools: CODEX_NATIVE_TOOLS, gatePrefix: GATE_PREFIX,
    ...(options.resume ? { resume: true } : {}),
    ...(options.profile ? { profile: options.profile } : {}),
  }
}
