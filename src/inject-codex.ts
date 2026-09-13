// Whole-block context delivery. An explicit optional byte budget limits selected injects.
import { packBlocks, type DroppedInject, type InjectBlock, type InjectTree, type PackBlock } from '@arsumbris/au-mcp'

export const INJECT_ROOT = 'inject'
export const CONTENT_FILE = 'content.md'

export function codexInjectTransform(blocks: InjectBlock[]): InjectTree {
  return renderInjectTree(blocks)
}

/** Whole blocks only. The byte budget includes envelopes and the bounded overflow notice. */
export function renderInjectTree(blocks: InjectBlock[], opts: { budget?: number } = {}): InjectTree {
  if (opts.budget !== undefined && (!Number.isSafeInteger(opts.budget) || opts.budget < 256)) throw new Error('Inject budget must be at least 256 bytes')
  if (blocks.length === 0) return { files: [], pluginRoots: [], dropped: [] }
  const rendered: PackBlock[] = blocks.map(b => {
    const addr = `[[${b.stem}::${b.repo}]]`
    return { key: b.key, addr, text: `<injected file ${addr}>\n\n${b.body.trim()}\n\n</injected file ${addr}>\n` }
  })
  const full = rendered.map(b => b.text).join('\n') + '\n'
  if (opts.budget === undefined || Buffer.byteLength(full) <= opts.budget) return tree(full, [])

  const noticeBudget = Math.min(4096, Math.floor(opts.budget / 3))
  const bodyBudget = opts.budget - noticeBudget - 2
  let bytes = 0
  let chars = 0
  let count = 0
  for (const block of rendered) {
    const separator = count ? 1 : 0
    const next = Buffer.byteLength(block.text) + separator
    if (bytes + next > bodyBudget) break
    bytes += next
    chars += block.text.length + separator
    count++
  }
  // The shared packer owns atomic block packing. Compute its character bound from the
  // UTF-8 prefix that fits, since the harness-specific output ceiling is measured in bytes.
  const packed = count ? packBlocks(rendered, { budget: chars, maxSlots: 1 }) : { slots: [], dropped: rendered }
  const notice = overflowNotice(packed.dropped, noticeBudget)
  const content = [...packed.slots, notice].join('\n') + '\n'
  if (Buffer.byteLength(content) > opts.budget) throw new Error('Inject output exceeded its byte budget')
  return tree(content, packed.dropped)
}

function tree(content: string, dropped: DroppedInject[]): InjectTree {
  return { files: [{ relPath: `${INJECT_ROOT}/${CONTENT_FILE}`, content }], pluginRoots: [INJECT_ROOT], dropped }
}

function overflowNotice(dropped: DroppedInject[], budget: number): string {
  let notice = `<injected budget-overflow>\n${dropped.length} blocks NOT injected; full list in launch diagnostics.\n`
  const end = '</injected budget-overflow>'
  // Every omitted address remains in the driver's structured dropped list. The in-band
  // notice itself must not grow without limit when a profile contains many large addresses.
  if (Buffer.byteLength(notice + end) > budget) return `${dropped.length} blocks NOT injected; see launch diagnostics.`
  for (const block of dropped) {
    const line = `- ${block.addr}\n`
    if (Buffer.byteLength(notice + line + end) > budget) break
    notice += line
  }
  return notice + end
}
