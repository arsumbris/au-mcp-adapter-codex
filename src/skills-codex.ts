// Render skill files for the launcher's generated capability directory.
// allowed-tools is emitted as skill metadata; Arsumbris tool authorization remains a daemon concern.
import { createHash } from 'node:crypto'
import type { Skill, SkillTree } from '@arsumbris/au-mcp'

import { GATE_PREFIX } from './surface.ts'

/** Skill directory relative to the generated capability root. */
const SKILLS_ROOT = 'skills'

/** Render mcp.skill instances as a Codex skill file tree. */
export function codexSkillTransform(skills: Skill[]): SkillTree {
  // A skill `name` owned by >1 owner collides on the flat `skills/<name>/` folder → disambiguate.
  const owners = new Map<string, Set<string>>()
  for (const s of skills) owners.set(s.name, (owners.get(s.name) ?? new Set()).add(s.owner))

  const candidates = skills.map(skill => (owners.get(skill.name)?.size ?? 0) > 1 ? `${skill.owner}-${skill.name}` : skill.name)
  const counts = new Map<string, number>()
  for (const id of candidates) counts.set(id, (counts.get(id) ?? 0) + 1)
  const used = new Set<string>()
  const identities = new Set<string>()
  const files: SkillTree['files'] = []
  for (const skill of [...skills].sort((a, b) => a.name.localeCompare(b.name) || a.owner.localeCompare(b.owner))) {
    for (const part of [skill.name, skill.owner]) {
      if (!part || part === '.' || part === '..' || /[\\/\x00-\x1f]/.test(part)) throw new Error(`Invalid Codex skill identity: ${JSON.stringify(part)}`)
    }
    const key = `${skill.owner}\0${skill.name}`
    if (identities.has(key)) throw new Error(`Duplicate skill identity: ${skill.owner}:${skill.name}`)
    identities.add(key)
    let id = (owners.get(skill.name)?.size ?? 0) > 1 ? `${skill.owner}-${skill.name}` : skill.name
    if ((counts.get(id) ?? 0) > 1) id += `-${createHash('sha256').update(key).digest('hex').slice(0, 12)}`
    if (used.has(id)) throw new Error(`Colliding Codex skill path: ${id}`)
    used.add(id)
    files.push({ relPath: `${SKILLS_ROOT}/${id}/SKILL.md`, content: skillMarkdown(skill, id) })
  }
  return { files, pluginRoots: files.length > 0 ? [SKILLS_ROOT] : [] }
}

/** Render the body and YAML metadata using this adapter's MCP tool names. */
function skillMarkdown(skill: Skill, id: string): string {
  const front = [`name: ${yamlScalar(id)}`, `description: ${yamlScalar(skill.description)}`]
  const allowed = skill.allowedTools.map(codexToolName)
  if (allowed.length > 0) front.push(`allowed-tools: [${allowed.join(', ')}]`)

  const body = skill.body.trim()
  return `---\n${front.join('\n')}\n---\n\n${body}${body ? '\n' : ''}`
}

/** Convert a tool definition name to this adapter's MCP tool name. */
function codexToolName(defName: string): string {
  return `${GATE_PREFIX}${defName.replace(/^mcp\.tool\./, '')}`
}

/** Quote a scalar when YAML would otherwise mis-read it (`:` and `#` are the live risks in prose). */
function yamlScalar(value: string): string {
  return !value || /[:#\n\r\t]|^\s|\s$|^[!&*{}\[\],%@`>|'"]/.test(value) || /^(?:true|false|null|yes|no|on|off|~|[-+]?\d.*)$/i.test(value)
    ? JSON.stringify(value) : value
}
