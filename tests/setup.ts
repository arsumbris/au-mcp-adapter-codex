import { afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'

// Isolate the SDK's device paths, including hooks and daemons spawned by a test.
const previous = process.env.HOME
// Keep Unix socket paths below macOS's length limit.
const fixtureHome = mkdtempSync('/tmp/au-device-')
process.env.HOME = fixtureHome
afterAll(() => {
  if (previous === undefined) delete process.env.HOME
  else process.env.HOME = previous
  rmSync(fixtureHome, { recursive: true, force: true })
})
