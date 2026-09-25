// Codex's stdio MCP surface. Thread identity comes from harness metadata, never tool input.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import {
  connectSocket, createDaemonClient, DaemonConnectionError, socketPath,
  LAUNCH_ENV, parseProfile, parseSessionHandle,
  type DaemonClient, type AdapterInfo,
} from '@arsumbris/au-mcp-sdk'
import { buildTools } from './advertise.ts'
import { codexAdapterInfo, MCP_SERVER_NAME } from './surface.ts'
import { assertLaunchSession } from './thread-registry.ts'
import { resolveLaunchEnv } from './launch-env.ts'
import { recoverStartupContext } from './bridge.ts'
import { openCodexSession } from './session-open.ts'
import { markStartupContextEmitted, type StartupDelivery } from './startup-readiness.ts'

type Capabilities = Awaited<ReturnType<DaemonClient['listCapabilities']>>
const NO_CAPS: Capabilities = { callables: [] }
const READINESS_TIMEOUT_MS = 8_000
const INVOCATION_TIMEOUT_MS = 120_000

// Discovery and registration must finish within Codex's startup budget. Invocations
// can legitimately take longer; keep their deadline independent on the same client.
async function readiness<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DaemonConnectionError('timeout', `au-mcp readiness did not respond within ${timeoutMs}ms`)), timeoutMs)
    })])
  } finally { if (timer !== undefined) clearTimeout(timer) }
}
const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true })
const message = (e: unknown) => e instanceof Error ? e.message : String(e)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Codex 0.153.2 emits an object here (turn_metadata.rs:230), not a JSON header string. */
export function codexThreadId(meta: unknown): string {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('Missing Codex MCP turn metadata; no tool was invoked.')
  const turn = (meta as Record<string, unknown>)['x-codex-turn-metadata']
  const id = turn && typeof turn === 'object' && !Array.isArray(turn)
    ? (turn as Record<string, unknown>).thread_id : undefined
  if (typeof id !== 'string' || !UUID.test(id)) throw new Error('Missing or invalid Codex thread_id in MCP turn metadata; no tool was invoked.')
  return id
}

async function dialDaemon(workspace: string, onDisconnect?: () => void): Promise<DaemonClient | null> {
  const transport = await connectSocket(socketPath(workspace)).catch(() => null)
  if (!transport) return null
  return createSocketDaemonClient(transport, onDisconnect)
}

/** SocketTransport has one close handler. Preserve the SDK's rejection callback when
 * adding lifecycle observation, rather than replacing it with our own subscriber. */
export function createSocketDaemonClient(transport: Awaited<ReturnType<typeof connectSocket>>, onDisconnect?: () => void): DaemonClient {
  let rejectPending: ((reason?: Error) => void) | undefined
  const client = createDaemonClient({ ...transport, onClose: handler => { rejectPending = handler } }, { requestTimeoutMs: INVOCATION_TIMEOUT_MS })
  transport.onClose?.(reason => {
    rejectPending?.(reason)
    client.dispose()
    onDisconnect?.()
  })
  return { ...client, dispose: () => transport.close() }
}

export interface McpGatewayOptions {
  workspace: string
  handle?: string
  profile?: string
  connect?: (workspace: string, onDisconnect?: () => void) => Promise<DaemonClient | null>
  assertMembership?: (session: string, workspace: string, handle: string) => void
  onToolsChanged?: () => void
  /** Deadline for discovery and session registration, independently of tool execution. */
  readinessTimeoutMs?: number
  /** Injectable startup boundary for isolated transport tests. */
  recoverStartup?: (session: string) => Promise<StartupDelivery | undefined>
  openSession?: (client: DaemonClient, info: AdapterInfo) => Promise<void>
}

/** Injectable transport boundary: safe reads can reconnect; invocation is sent at most once. */
export function createMcpGateway(options: McpGatewayOptions) {
  const connect = options.connect ?? dialDaemon
  const assertMembership = options.assertMembership ?? assertLaunchSession
  const readinessTimeoutMs = options.readinessTimeoutMs ?? READINESS_TIMEOUT_MS
  if (!Number.isFinite(readinessTimeoutMs) || readinessTimeoutMs <= 0) throw new Error('readinessTimeoutMs must be positive and finite')
  let client: DaemonClient | null = null
  let caps = NO_CAPS
  let refreshing: Promise<boolean> | undefined
  let disposed = false
  let connected = false

  function drop(failed: DaemonClient) {
    if (client === failed) { client = null; connected = false }
    failed.dispose()
  }
  function setCapabilities(next: Capabilities) {
    const changed = JSON.stringify(buildTools(caps.callables)) !== JSON.stringify(buildTools(next.callables))
    caps = next
    if (changed) options.onToolsChanged?.()
  }
  async function refresh(): Promise<boolean> {
    if (disposed) return false
    if (refreshing) return refreshing
    refreshing = (async () => {
      // One budget covers connect + both read attempts, including a failed first dial.
      const deadline = Date.now() + readinessTimeoutMs
      // list-capabilities is read-only. Retrying it cannot repeat a mutation.
      for (let attempt = 0; attempt < 2; attempt++) {
        if (Date.now() >= deadline) break
        let current = client
        if (!current) {
          const opening = connect(options.workspace, () => { connected = false }).catch(() => null)
          try { current = await readiness(opening, Math.max(1, deadline - Date.now())) }
          catch {
            // A late successful connection must not leak after its caller stopped waiting.
            void opening.then(late => late?.dispose())
            break
          }
        }
        if (disposed) { current?.dispose(); return false }
        if (!current) continue
        client = current
        try {
          const next = await readiness(current.listCapabilities(undefined, options.profile), Math.max(1, deadline - Date.now()))
          if (disposed) return false
          connected = true
          setCapabilities(next)
          return true
        } catch (e) {
          drop(current)
          // A silent daemon does not become responsive by dialing it again.
          if (e instanceof DaemonConnectionError && e.code === 'timeout') break
        }
      }
      connected = false
      setCapabilities(NO_CAPS)
      return false
    })().finally(() => { refreshing = undefined })
    return refreshing
  }

  return {
    refresh,
    get capabilities() { return caps },
    get connected() { return connected },
    get tools() { return buildTools(caps.callables) },
    async listTools() { await refresh(); return { tools: buildTools(caps.callables) } },
    async callTool(name: string, args: Record<string, unknown>, meta: unknown, startupResponse?: (delivery: StartupDelivery) => void) {
      if (!options.handle) return fail('Missing required AU_MCP_SESSION. Relaunch through the Arsumbris Codex launcher; no tool was invoked.')
      let session: string
      try {
        session = codexThreadId(meta)
        assertMembership(session, options.workspace, options.handle)
      } catch (e) { return fail(message(e)) }
      if (!await refresh()) return fail('au-mcp daemon not reachable or not responding for this workspace; no tool was invoked.')
      if (!buildTools(caps.callables).some(tool => tool.name === name)) return fail(`tool not available in this session: ${name}`)
      try {
        const delivery = await (options.recoverStartup ?? (thread => recoverStartupContext({ session_id: thread, cwd: options.workspace })))(session)
        if (delivery?.required && delivery.context) {
          startupResponse?.(delivery)
          return fail(`Arsumbris startup instructions were recovered. This tool did not run. Read the following context before retrying the intended action:\n\n${delivery.context}`)
        }
        if (delivery) markStartupContextEmitted(delivery)
      } catch (e) { return fail(`Arsumbris initialization remains pending; no tool was invoked: ${message(e)}`) }
      const current = client!
      try {
        // Raw thread IDs are supported by the SDK. Never bind the shared launch handle:
        // every subagent has its own ID and must not replace the parent's attribution.
        await (options.openSession ?? ((client, info) => openCodexSession(client, info, { timeoutMs: readinessTimeoutMs, handle: options.handle })))(current, codexAdapterInfo(session, options.workspace, {
          profile: options.profile,
        }))
      } catch (e) {
        drop(current)
        return fail(`Unable to register Codex thread with au-mcp; no tool was invoked: ${message(e)}`)
      }
      try {
        const { result, isError } = await current.invoke(session, `mcp.${name}`, args)
        return { content: [{ type: 'text' as const, text: typeof result === 'string' ? result : JSON.stringify(result ?? null, null, 2) }], isError }
      } catch (e) {
        drop(current)
        // The daemon can commit a write before its response is lost. No automatic retry,
        // including timeouts and unclassified transport errors; report uncertainty explicitly.
        return fail(`au-mcp invocation outcome is unknown: ${message(e)}. The action may have completed. It was not retried; inspect the resulting state before repeating it.`)
      }
    },
    dispose() { disposed = true; client?.dispose(); client = null; connected = false },
  }
}

export async function runMcpServer(workspace: string): Promise<void> {
  let server: Server | undefined
  let ready = false
  const startupResponses = new Map<string | number, StartupDelivery>()
  const env = resolveLaunchEnv()
  const handle = parseSessionHandle(env[LAUNCH_ENV.SESSION])
  const gateway = createMcpGateway({
    workspace, handle,
    profile: parseProfile(env[LAUNCH_ENV.PROFILE]),
    onToolsChanged: () => {
      if (ready && server) void server.sendToolListChanged().catch(() => {})
    },
  })
  if (!await gateway.refresh()) {
    gateway.dispose()
    throw new Error('Arsumbris MCP startup failed: the workspace daemon is unavailable or not ready. Start the daemon, then reconnect MCP or resume Codex; no valid tool catalogue was advertised.')
  }
  server = new Server({ name: MCP_SERVER_NAME, version: '0.0.0' }, {
    capabilities: { tools: { listChanged: true } },
    instructions: handle ? undefined : `The ${MCP_SERVER_NAME} server cannot invoke tools: AU_MCP_SESSION is missing. Relaunch through the Arsumbris Codex launcher.\n`,
  })
  server.setRequestHandler(ListToolsRequestSchema, () => gateway.listTools())
  server.setRequestHandler(CallToolRequestSchema, (request, extra) => gateway.callTool(
    request.params.name, request.params.arguments ?? {}, request.params._meta,
    delivery => { startupResponses.set(extra.requestId, delivery) },
  ))
  // Reconnect a previously initialized connection. Codex 0.153.2 only logs list_changed;
  // newly added tools require MCP reconnect/resume even though tools/list itself is fresh.
  const recovery = setInterval(() => { if (!gateway.connected) void gateway.refresh() }, 5_000)
  recovery.unref()
  server.onclose = () => { clearInterval(recovery); startupResponses.clear(); gateway.dispose() }
  server.onerror = error => process.stderr.write(`au-mcp shim: ${message(error)}\n`)
  try {
    const stdio = new StdioServerTransport()
    const send = stdio.send.bind(stdio)
    stdio.send = async message => {
      await send(message)
      // The protocol response must be queued before advancing readiness. This is a
      // delivery attempt only: MCP provides no model-consumption acknowledgement.
      if ('id' in message && message.id !== undefined) {
        const delivery = startupResponses.get(message.id)
        if (delivery) {
          startupResponses.delete(message.id)
          try { markStartupContextEmitted(delivery) }
          catch (error) { process.stderr.write(`au-mcp startup delivery checkpoint: ${String(error)}\n`) }
        }
      }
    }
    await server.connect(stdio)
    ready = true
  } catch (e) { clearInterval(recovery); gateway.dispose(); throw e }
}
