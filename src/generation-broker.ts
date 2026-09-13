// The shared discoverers treat unavailable/failed reads like an empty capability set.
// A prepared launch must distinguish those outcomes; retain error evidence outside their catch.
import { createEngineBroker, type EngineBroker } from '@arsumbris/au-mcp'

export async function withGenerationBroker<T>(entry: string, run: (broker: EngineBroker) => Promise<T>, create = createEngineBroker): Promise<T> {
  const inner = create(entry)
  const failures: string[] = []
  const broker: EngineBroker = {
    socketPath: inner.socketPath,
    available: () => {
      const ready = inner.available()
      if (!ready) failures.push('Engine daemon is unavailable')
      return ready
    },
    read: async (op, args, timeoutMs) => {
      try {
        const frame = await inner.read(op, args, timeoutMs)
        if (frame.type === 'error' || frame.ready === false) failures.push(`Engine ${op} failed: ${String(frame.message ?? 'workspace not ready')}`)
        else if (op === 'instances_of' && !Array.isArray(frame.result)) failures.push('Engine instances_of returned an invalid discovery result')
        return frame
      } catch (error) {
        failures.push(`Engine ${op} failed: ${error instanceof Error ? error.message : String(error)}`)
        throw error
      }
    },
    mutate: async () => { throw new Error('Generation must not mutate engine content') },
  }
  try {
    if (!broker.available()) throw new Error(`Engine daemon is unavailable for ${entry}; start it before preparing a launch`)
    const result = await run(broker)
    if (failures.length) throw new Error([...new Set(failures)].join('; '))
    return result
  } finally { inner.close?.() }
}
