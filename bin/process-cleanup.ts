// Whole-process cleanup is separate from a conversation's SessionEnd hook.
import { connectSocket, createDaemonClient, socketPath } from '@arsumbris/au-mcp-sdk'
import { closeOwnedProcessThreads, listLaunchSessions } from '../src/thread-registry.ts'
import { resolveLaunchEnv } from '../src/launch-env.ts'
const env = resolveLaunchEnv()
try {
  if (listLaunchSessions(env.AU_MCP_WORKSPACE!, env.AU_MCP_SESSION!).length === 0) process.exit(0)
  const transport = await connectSocket(socketPath(env.AU_MCP_WORKSPACE!))
  const client = createDaemonClient(transport, { requestTimeoutMs: 350 })
  try { await closeOwnedProcessThreads(thread => client.sessionClose(thread), env.AU_MCP_WORKSPACE!, env.AU_MCP_SESSION!) }
  finally { client.dispose(); transport.close() }
} catch (error) { process.stderr.write(`Codex process cleanup incomplete: ${String(error)}\n`) }
