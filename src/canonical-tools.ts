// Source: Codex 0.153.2 (657a993c...), core/src/tools/hook_names.rs and
// handlers/mcp.rs::join_tool_name/ensure_mcp_prefix. Actual native rollouts use
// namespace "functions". Resolve the MCP namespace before native aliases so an
// MCP tool called exec_command remains that server's tool.
const SHELL_TOOLS = new Set(['exec_command', 'write_stdin', 'shell', 'shell_command', 'Bash'])
export function codexHookToolName(name: unknown, namespace?: unknown): string | null {
  if (typeof name !== 'string' || !name) return null
  if (namespace === 'multi_agent_v1') return name === 'spawn_agent' ? 'spawn_agent' : `${namespace}${name}`
  if (typeof namespace === 'string' && namespace && namespace !== 'functions') {
    const joined = `${namespace.replace(/_+$/, '')}__${name.replace(/^_+/, '')}`
    return joined.startsWith('mcp__') ? joined : `mcp__${joined}`
  }
  if (name.startsWith('mcp__')) return name
  if (SHELL_TOOLS.has(name)) return 'Bash'
  return name
}
