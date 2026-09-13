// Supply invocation-scoped AU capabilities to Codex while preserving its native storage.
import { createDaemonClient, connectSocket, socketPath } from '@arsumbris/au-mcp-sdk'
import { codexResumeRef, parseResumeRef } from './resume-ref.ts'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { isAbsolute, join } from 'node:path'
import WebSocket, { WebSocketServer } from 'ws'
import { hooksToml, mcpServerPath } from './launch.ts'
import { RUN_ID_ENV, assertLaunchSession } from './thread-registry.ts'
import { adapterStateDir, assertGeneratedContent, generatedPaths, SKILLS_ENV, LAUNCH_ENV_KEYS, resolveLaunchEnv } from './launch-env.ts'
import { acquireFileLock } from './file-lock.ts'
import { cleanupProcessThreads } from './process-cleanup.ts'
import { verifyProfile } from './profile-preflight.ts'
import { MCP_SERVER_NAME } from './surface.ts'

export class ServerBusyError extends Error {}

export async function connectServerSocket(socketPath: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    // Codex's Unix WebSocket transport requires an uncompressed connection.
    const socket = new WebSocket(`ws+unix://${socketPath}:/`, { handshakeTimeout: 1000, perMessageDeflate: false })
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })
}

export function rpc(socket: WebSocket, method: string, params: unknown, id = randomUUID()): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); socket.off('message', onMessage); socket.off('close', onClose) }
    const onClose = () => { cleanup(); reject(new Error(`App-server disconnected during ${method}`)) }
    const onMessage = (data: WebSocket.RawData) => {
      let reply
      try { reply = JSON.parse(data.toString()) } catch { cleanup(); reject(new Error('Malformed app-server reply')); return }
      if (reply?.id !== id) return
      cleanup()
      if (reply.error) reject(new Error(JSON.stringify(reply.error)))
      else resolve(reply.result)
    }
    const timer = setTimeout(() => { cleanup(); reject(new Error(`App-server timed out during ${method}`)) }, 12000)
    socket.on('message', onMessage)
    socket.once('close', onClose)
    socket.send(JSON.stringify({ id, method, params }), error => { if (error) { cleanup(); reject(error) } })
  })
}

/** Configuration is supplied only to this invocation. Personal config stays untouched. */
export function invocationConfig(): string[] {
  const config = hooksToml().split('\n').filter(line => line.includes(' = ')).flatMap(line => ['-c', `hooks.${line}`])
  config.push(
    '-c', `mcp_servers.${MCP_SERVER_NAME}.enabled=true`,
    '-c', `mcp_servers.${MCP_SERVER_NAME}.command=${JSON.stringify(process.execPath)}`,
    '-c', `mcp_servers.${MCP_SERVER_NAME}.args=${JSON.stringify([mcpServerPath()])}`,
    '-c', `mcp_servers.${MCP_SERVER_NAME}.env_vars=${JSON.stringify([...LAUNCH_ENV_KEYS, 'CODEX_HOME'])}`,
  )
  return config
}

export async function startServer(launchEnv: NodeJS.ProcessEnv, binary: string, extraConfig: string[] = [], signal?: AbortSignal) {
  signal?.throwIfAborted()
  if (!isAbsolute(binary)) throw new Error('Codex executable must be an absolute path')
  const env = { ...process.env }
  for (const key of LAUNCH_ENV_KEYS) delete env[key]
  Object.assign(env, launchEnv, { [RUN_ID_ENV]: randomUUID() })
  resolveLaunchEnv(env)
  assertGeneratedContent(env)
  const workspace = env.AU_MCP_WORKSPACE
  const handle = env.AU_MCP_SESSION
  if (!workspace || !handle || !env.CODEX_HOME) throw new Error('Missing Codex launch environment')
  if (env.AU_MCP_PROFILE) await verifyProfile(workspace, env.AU_MCP_PROFILE)
  signal?.throwIfAborted()
  const leasePath = join(adapterStateDir(env)!, 'leases', `${createHash('sha256').update(handle).digest('hex')}.lock`)
  const lease = acquireFileLock(leasePath)
  if (!lease) throw new ServerBusyError('This Codex launch is already active')
  const releaseLease = lease.release
  let directory: string
  try { directory = mkdtempSync('/tmp/au-codex-') } catch (error) { releaseLease(); throw error }
  const backendPath = join(directory, 'backend.sock')
  const frontendPath = join(directory, 'tui.sock')
  const config = invocationConfig()
  // Inherit the lease: killing the Node supervisor cannot unlock a living server.
  const backend = spawn(binary, ['app-server', '--listen', `unix://${backendPath}`, ...config, ...extraConfig], {
    env, cwd: workspace, stdio: ['ignore', 'ignore', 'pipe', lease.fd],
  })
  let stderr = ''
  let spawnError: Error | undefined
  backend.on('error', error => { spawnError = error })
  backend.stderr!.on('data', data => { stderr = (stderr + String(data)).slice(-16000) })
  const exited = new Promise<void>(resolve => {
    backend.once('exit', () => resolve())
    backend.once('error', () => { if (backend.pid === undefined) resolve() })
  })
  let control: WebSocket | undefined
  const sockets = new Set<WebSocket>()
  const http = createServer()
  const proxy = new WebSocketServer({ noServer: true, perMessageDeflate: false })
  const diagnostics: string[] = []
  const diagnose = (message: string) => { diagnostics.push(message); if (diagnostics.length > 100) diagnostics.shift() }
  let closing: Promise<void> | undefined
  function close(): Promise<void> {
    return closing ??= (async () => {
      for (const socket of sockets) socket.terminate()
      control?.terminate()
      proxy.close()
      http.close()
      if (!spawnError && backend.exitCode === null && backend.signalCode === null) backend.kill('SIGTERM')
      const timer = setTimeout(() => backend.kill('SIGKILL'), 5000)
      await exited
      clearTimeout(timer)
      // A living descendant can retain stderr after the app-server exits.
      backend.stderr!.destroy()
      releaseLease()
      // Whole-process cleanup only after all inherited lease holders have exited.
      const deadline = Date.now() + 3000
      for (;;) {
        const drained = acquireFileLock(leasePath, { timeoutMs: 250 })
        if (drained) {
          try {
            stderr += await cleanupProcessThreads(env)
          } finally { drained.release() }
          break
        }
        if (Date.now() >= deadline) { stderr += '\nA descendant retains the server lease; cleanup was deferred.'; break }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      rmSync(directory, { recursive: true, force: true })
    })()
  }
  backend.once('exit', () => { for (const socket of sockets) socket.close(1011, 'Native app-server exited') })
  const abortStartup = () => { backend.kill('SIGTERM'); control?.terminate() }
  signal?.addEventListener('abort', abortStartup, { once: true })
  try {
    const deadline = Date.now() + 12000
    let lastConnectError: unknown
    while (!control) {
      signal?.throwIfAborted()
      if (spawnError || backend.exitCode !== null || backend.signalCode !== null || Date.now() >= deadline) {
        throw new Error(`Native app-server did not start: ${String(spawnError ?? lastConnectError)}; ${stderr}`)
      }
      try { control = await connectServerSocket(backendPath) }
      catch (error) { lastConnectError = error; await new Promise(resolve => setTimeout(resolve, 40)) }
    }
    await rpc(control, 'initialize', { clientInfo: { name: 'arsumbris_launcher', version: '1' }, capabilities: { experimentalApi: true } })
    control.send(JSON.stringify({ method: 'initialized' }))
    await rpc(control, 'skills/extraRoots/set', { extraRoots: generatedPaths(SKILLS_ENV, env) })
    signal?.throwIfAborted()
    http.on('upgrade', (request, socket, head) => proxy.handleUpgrade(request, socket, head, client => proxy.emit('connection', client)))
    proxy.on('connection', async client => {
      sockets.add(client)
      client.on('error', () => client.terminate())
      client.once('close', () => sockets.delete(client))
      const waiting: WebSocket.RawData[] = []
      const queue = (data: WebSocket.RawData) => waiting.push(data)
      client.on('message', queue)
      let upstream: WebSocket
      try { upstream = await connectServerSocket(backendPath) }
      catch { client.close(1011, 'Native app-server unavailable'); return }
      if (client.readyState !== WebSocket.OPEN) { upstream.close(); return }
      sockets.add(upstream)
      const forward = async (data: WebSocket.RawData) => {
        let request: { id?: string | number; method?: string; params?: { threadId?: string } } | undefined
        try {
          request = JSON.parse(data.toString())
          if (!request || typeof request !== 'object') throw new Error('Invalid protocol message')
          diagnose(`request ${request.id} ${request.method}`)
          if (request.method === 'skills/extraRoots/set') throw new Error('This server has a fixed Arsumbris capability selection; prepare a new launch to change it.')
          if (request.method === 'thread/resume') {
            const thread = request.params?.threadId ?? ''
            let attached = false
            try { assertLaunchSession(thread, workspace, handle, adapterStateDir(env)); attached = true } catch {}
            if (!attached) {
              const transport = await connectSocket(socketPath(workspace))
              const daemon = createDaemonClient(transport, { requestTimeoutMs: 8000 })
              try {
                const session = (await daemon.listDormant()).find(s => s.id === thread)
                if (!session?.resumeRef || session.harness !== 'mcp.adapter.codex') throw new Error('No kernel-tracked resume recipe; cold relaunch is not supported by this server.')
                const recipe = parseResumeRef(session.resumeRef)
                const selected = parseResumeRef(codexResumeRef(thread, env)!)
                if (recipe.home !== selected.home || recipe.workspace !== selected.workspace ||
                    (['skills', 'inject', 'injectBudget', 'profile'] as const).some(key =>
                      JSON.stringify(recipe.selections[key]) !== JSON.stringify(selected.selections[key]))) throw new Error('This thread has a different capability selection; resume it through the AU launcher.')
              } finally { daemon.dispose(); transport.close() }
            }
          }
          if (upstream.readyState !== WebSocket.OPEN) throw new Error('Native app-server disconnected')
          upstream.send(data.toString())
        } catch (error) {
          if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ id: request?.id ?? null, error: { code: -32600, message: String(error) } }))
        }
      }
      client.off('message', queue)
      let forwarding = Promise.resolve()
      client.on('message', data => { forwarding = forwarding.then(() => forward(data)) })
      upstream.on('message', data => {
        if (client.readyState === WebSocket.OPEN) client.send(data.toString())
      })
      client.on('close', () => upstream.close())
      upstream.on('close', () => { sockets.delete(upstream); client.close() })
      upstream.on('error', () => client.close(1011, 'Native app-server connection failed'))
      for (const data of waiting) forwarding = forwarding.then(() => forward(data))
    })
    await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(frontendPath, resolve) })
    signal?.throwIfAborted()
    return { endpoint: `unix://${frontendPath}`, socketPath: frontendPath, control, env, backend, close, stderr: () => stderr + '\n' + diagnostics.join('\n') }
  } catch (error) { await close(); throw error }
  finally { signal?.removeEventListener('abort', abortStartup) }
}
