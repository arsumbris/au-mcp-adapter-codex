// Detect path-like @mentions before Codex expands them outside governed tool calls.
// The heuristic requires a dot or slash and skips email addresses; it can over- or undermatch.

const FILE_MENTION = /(?:^|\s)@[^\s]*[./][^\s]*/

/** Does the prompt contain a path-like `@file` mention? */
export function hasFileMention(prompt: string): boolean {
  return FILE_MENTION.test(prompt)
}
