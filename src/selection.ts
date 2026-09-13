/** A stale profile selection is an error, not permission to launch with missing capabilities. */
export function assertSelectedPresent(selected: string[] | undefined, materialized: Array<{ owner: string; name: string }>): void {
  if (selected === undefined) return
  const present = new Set(materialized.map(item => `${item.owner}:${item.name}`))
  const missing = [...new Set(selected.filter(key => !present.has(key)))]
  if (missing.length) throw new Error(`Selected capabilities were not found: ${missing.join(', ')}`)
}
