// Opt-in real engine proof: authored schema -> discovery -> generated launch -> typed startup hook.
import { it, expect, vi } from 'vitest'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { startDaemon, createEngineBroker } from '@arsumbris/au-mcp'
import { prepareLaunch } from '../src/launch.ts'
import { verifyProfile } from '../src/profile-preflight.ts'
import { generatedPaths, SKILLS_ENV, INJECT_ENV } from '../src/launch-env.ts'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const exec = promisify(execFile)
const engine = process.env.AU_ENGINE_TEST_BINARY
it.skipIf(!engine)('generates isolated selections using a real engine and passes authored profile config into startup hooks', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(),'au-codex-engine-')))
  vi.stubEnv('CODEX_HOME', join(root, 'home'))
  const workspace = join(root,'fixture')
  const sdk = resolve(import.meta.dirname,'../../au-mcp-sdk')
  const write = (file:string, text:string) => {mkdirSync(join(file,'..'),{recursive:true});writeFileSync(file,text)}
  write(join(root,'au-mcp-sdk/.arsumbris/repo.yaml'),readFileSync(join(sdk,'.arsumbris/repo.yaml'),'utf8'))
  cpSync(join(sdk,'type'),join(root,'au-mcp-sdk/type'),{recursive:true})
  write(join(workspace,'.arsumbris/repo.yaml'),'type: au.engine.repo::au-engine\nname: fixture\ndescription: isolated adapter acceptance fixture\ndeps:\n  - name: au-mcp-sdk\n')
  write(join(workspace,'type/mcp.hook.fixture.type.yaml'),'extends: mcp.hook::au-mcp-sdk\nfields:\n  label: String\n')
  write(join(workspace,'type/mcp.tool.fixture_profiles.type.yaml'),'extends: mcp.tool::au-mcp-sdk\nfields: {}\nmeta:\n  - type: tool-presentation-meta::au-mcp-sdk\n    description: Read fixture profiles from the real engine\n')
  write(join(workspace,'profile.yaml'),'type: agent-profile::au-mcp-sdk\nhookConfig:\n  - type: mcp.hook.fixture\n    label: ENGINE_TYPED_CONFIG_SENTINEL\n')
  for (const name of ['alpha','beta']) {
    write(join(workspace,`skills/${name}.md`),`---\ntype: mcp.skill::au-mcp-sdk\nname: ${name}\ndescription: Real engine ${name} skill\n---\n\nENGINE_SKILL_${name}\n`)
    write(join(workspace,`inject/${name}.md`),`---\ntype: mcp.inject::au-mcp-sdk\nname: ${name}\ndescription: Real engine ${name} context\n---\n\nENGINE_INJECT_${name}\n`)
  }
  const child = spawn(engine!,['daemon','start',workspace],{stdio:['ignore','pipe','pipe']})
  let diagnostics = '';child.stdout.on('data',b=>diagnostics+=String(b));child.stderr.on('data',b=>diagnostics+=String(b))
  let running: Awaited<ReturnType<typeof startDaemon>> | undefined
  try {
    const deadline=Date.now()+20000
    for (;;) {
      try {await verifyProfile(workspace,join(workspace,'profile.yaml'));break} catch (error) {
        if(Date.now()>deadline || child.exitCode!==null) throw Error(`Engine did not become ready: ${String(error)}\n${diagnostics}`)
        await new Promise(r=>setTimeout(r,100))
      }
    }
    let previousSkillsRoot: string | undefined
    for(const name of ['alpha','beta']) {
      const launch=await prepareLaunch({entry:workspace,binary:'/opt/homebrew/bin/codex',skills:[`fixture:${name}`],inject:[`fixture:${name}`],profile:join(workspace,'profile.yaml')})
      const skillsRoot = generatedPaths(SKILLS_ENV, launch.env)[0]
      if (previousSkillsRoot) {
        expect(skillsRoot).not.toBe(previousSkillsRoot)
        expect(readdirSync(previousSkillsRoot)).toEqual(['alpha'])
      }
      previousSkillsRoot = skillsRoot
      expect(readdirSync(skillsRoot)).toEqual([name])
      expect(readFileSync(join(skillsRoot,name,'SKILL.md'),'utf8')).toContain(`ENGINE_SKILL_${name}`)
      const content=readFileSync(generatedPaths(INJECT_ENV, launch.env)[0],'utf8')
      expect(content).toContain(`ENGINE_INJECT_${name}`)
      expect(content).not.toContain(`ENGINE_INJECT_${name==='alpha'?'beta':'alpha'}`)
      if(name==='alpha') {
        const configs:unknown[]=[]
        const broker = createEngineBroker(workspace)
        running=await startDaemon({workspace,plugins:[{manifest:{id:'mcp.fixture',name:'fixture',kind:'hook',shapes:['session-start'],contractVersion:0},onSessionStart:(_ctx,config)=>{configs.push(config);return {inject:[`CONFIG:${JSON.stringify(config)}`]}}}, { manifest: { id: 'mcp.fixture_profiles', name: 'fixture_profiles', kind: 'tool', contractVersion: 0, inputSchema: { type: 'object', properties: {} } }, invoke: async () => ({ content: await broker.read('instances_of', { type: 'agent-profile' }) }) }]})
        const hook=spawn(process.execPath,['--experimental-strip-types',resolve(import.meta.dirname,'../hooks/session-start.ts')],{env:{...process.env,...launch.env},stdio:['pipe','pipe','pipe']})
        let stdout='';let stderr=''
        hook.stdout.on('data',b=>stdout+=String(b));hook.stderr.on('data',b=>stderr+=String(b))
        hook.stdin.end(JSON.stringify({session_id:'12345678-1234-1234-1234-123456789abc',cwd:workspace,source:'startup'}))
        const code=await new Promise<number|null>((resolve,reject)=>{
          const timer=setTimeout(()=>{hook.kill('SIGKILL');reject(Error('Startup hook timeout'))},20000)
          hook.once('error',e=>{clearTimeout(timer);reject(e)})
          hook.once('close',code=>{clearTimeout(timer);resolve(code)})
        })
        expect(code,stderr).toBe(0)
        expect(configs,diagnostics+stderr+stdout).toHaveLength(1)
        expect(configs[0]).toMatchObject({label:'ENGINE_TYPED_CONFIG_SENTINEL'})
        expect(stdout).toContain('ENGINE_TYPED_CONFIG_SENTINEL')
        const client = new Client({ name: 'real-engine-acceptance', version: '0' })
        try {
          await client.connect(new StdioClientTransport({ command: process.execPath,
            args: ['--experimental-strip-types', resolve(import.meta.dirname, '../bin/mcp-server.ts')],
            env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), ...launch.env },
          }))
          expect((await client.listTools()).tools.map(tool => tool.name)).toContain('fixture_profiles')
          const result = await client.callTool({ name: 'fixture_profiles', arguments: {},
            _meta: { 'x-codex-turn-metadata': { thread_id: '12345678-1234-1234-1234-123456789abc' } },
          })
          expect(result.isError, JSON.stringify(result.content)).toBeFalsy()
          expect(JSON.stringify(result.content)).toContain('ENGINE_TYPED_CONFIG_SENTINEL')
        } finally {
    await client.close(); broker.close?.() }

      }
    }
  } finally {
    vi.unstubAllEnvs()
    await running?.stop()
    await exec(engine!,['daemon','stop',workspace],{timeout:3000}).catch(()=>{})
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
      child.kill('SIGKILL')
      await closed
    }
    rmSync(root,{recursive:true,force:true})
  }
},60000)
