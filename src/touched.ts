// Extract mutation provenance from MCP result wrappers, content arrays, or JSON strings.
// The SDK owns the FileOpTouch contract and pinned target syntax.

import type { FileOpTouch } from '@arsumbris/au-mcp-sdk'

/** True for an MCP CallToolResult wrapper `{ content: [...] }` (Codex's real hook shape). */
function isContentWrapper(v: unknown): v is { content: unknown[] } {
  return !!v && typeof v === 'object' && Array.isArray((v as { content?: unknown }).content)
}

/** Concatenate the text blocks of a tool result — a `{ content: [...] }` wrapper OR a bare
 *  content array — or pass a bare string through. Any other shape yields ''. */
function responseText(toolResponse: unknown): string {
  if (typeof toolResponse === 'string') return toolResponse
  const blocks = Array.isArray(toolResponse)
    ? toolResponse
    : isContentWrapper(toolResponse)
      ? toolResponse.content
      : null
  if (blocks) {
    return (blocks as Array<{ text?: unknown }>)
      .map((b) => (b && typeof b.text === 'string' ? b.text : ''))
      .join('')
  }
  return ''
}

/** Parse the file-op `touched` pin material out of a Codex tool response, or null. */
export function extractTouch(toolResponse: unknown): FileOpTouch | null {
  const text = responseText(toolResponse).trim()
  if (!text || text[0] !== '{') return null // fast-path: only a JSON object can carry `touched`
  let parsed: { touched?: unknown }
  try {
    parsed = JSON.parse(text) as { touched?: unknown }
  } catch {
    return null // not JSON (a read's numbered listing, an error string)
  }
  const t = parsed?.touched
  if (t && typeof t === 'object' && typeof (t as FileOpTouch).path === 'string') {
    return t as FileOpTouch
  }
  return null
}
