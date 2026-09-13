import { afterEach, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { acquireFileLock } from '../src/file-lock.ts'

const roots: string[] = []
const children: ChildProcess[] = []
const temp = (): string => { const root = mkdtempSync(join(tmpdir(), 'au-file-lock-')); roots.push(root); return root }
afterEach(() => { for (const child of children.splice(0)) child.kill('SIGKILL'); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
async function firstOutput(child: ChildProcess): Promise<string> {
  return await new Promise((resolve, reject) => {
    child.stdout!.once('data', chunk => resolve(String(chunk)))
    child.once('error', reject)
    child.once('exit', code => reject(new Error(`Child exited ${code} before readiness`)))
  })
}

it('exclusive OS locks survive helper exit and reuse the same permanent inode after release', () => {
  const path = join(temp(), 'lease')
  const first = acquireFileLock(path)!
  try { expect(acquireFileLock(path)).toBeUndefined() } finally { first.release() }
  expect(existsSync(path)).toBe(true)
  const next = acquireFileLock(path)
  expect(next).toBeDefined(); next!.release(); next!.release()
})

it('simultaneous contenders acquire a single OS lock, without stale-file reclamation', async () => {
  const path = join(temp(), 'shared')
  const source = new URL('../src/file-lock.ts', import.meta.url).href
  const childrenReady = Array.from({ length: 4 }, () => {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `import{acquireFileLock}from ${JSON.stringify(source)};const lock=acquireFileLock(${JSON.stringify(path)});console.log(lock?'owned':'busy');if(lock){process.stdin.resume();process.stdin.once('data',()=>{lock.release();process.exit(0)})}`], { stdio: ['pipe', 'pipe', 'pipe'] })
    children.push(child)
    return firstOutput(child).then(output => ({ child, output }))
  })
  const results = await Promise.all(childrenReady)
  expect(results.filter(result => result.output.trim() === 'owned')).toHaveLength(1)
  const owner = results.find(result => result.output.trim() === 'owned')!.child
  const exited = once(owner, 'exit'); owner.stdin!.write('release'); await exited
  const after = acquireFileLock(path); expect(after).toBeDefined(); after!.release()
})

it('keeps the lease owned while a child retains its inherited descriptor', async () => {
  const path = join(temp(), 'inherited')
  const owner = acquireFileLock(path)!
  const child = spawn(process.execPath, ['-e', "console.log('ready');process.stdin.resume()"], { stdio: ['pipe', 'pipe', 'pipe', owner.fd] })
  children.push(child)
  try {
    await firstOutput(child)
    owner.release()
    expect(acquireFileLock(path)).toBeUndefined()
    const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited
    const next = acquireFileLock(path); expect(next).toBeDefined(); next!.release()
  } finally { owner.release() }
})
