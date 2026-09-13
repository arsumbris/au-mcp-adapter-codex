import { it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

it('emits a valid denial if hook input never arrives, before the harness can time out', async () => {
  const root=mkdtempSync(join(tmpdir(),'au-hook-deadline-'))
  const accelerator=join(root,'clock.mjs')
  // Accelerate long deadlines only inside this isolated child; the real executable and
  // stalled stdin path remain unchanged, with no daemon or user approval surface involved.
  writeFileSync(accelerator, 'const original=globalThis.setTimeout;globalThis.setTimeout=(fn,ms,...args)=>original(fn,ms>=100000?50:ms,...args)')
  const child=spawn(process.execPath,['--import',pathToFileURL(accelerator).href,resolve(import.meta.dirname,'../hooks/pre-tool-use.ts')],{stdio:['pipe','pipe','pipe']})
  let stdout='';let stderr=''
  child.stdout.on('data',b=>stdout+=String(b));child.stderr.on('data',b=>stderr+=String(b))
  try {
    const code=await new Promise<number|null>((resolve,reject)=>{
      const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Hook failed to enforce its deadline'))},5000)
      child.once('error',error=>{clearTimeout(timer);reject(error)})
      child.once('close',code=>{clearTimeout(timer);resolve(code)})
    })
    expect(code,stderr).toBe(0)
    expect(JSON.parse(stdout)).toMatchObject({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:expect.stringContaining('absolute deadline')}})
  } finally {child.kill('SIGKILL');rmSync(root,{recursive:true,force:true})}
})
