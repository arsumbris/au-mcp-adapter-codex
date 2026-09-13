import type { LaunchProfile } from './launch.ts'

/** Reject unknown or incomplete launch arguments. */
export function parseLaunchArguments(argv: string[], workspaceFallback?: string): LaunchProfile {
  const scalars: Record<string, string> = {}
  const selections: Record<string, string[]> = {}
  const scalarFlags = new Set(['--workspace', '--binary', '--profile', '--inject-budget', '--resume'])
  const selectionFlags = new Set(['--skills', '--inject'])
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--tools' || flag === '--native-tools') throw new Error(`${flag} is retired; configure tool permissions in an agent profile and pass --profile`)
    if (scalarFlags.has(flag)) {
      if (scalars[flag] !== undefined) throw new Error(`Duplicate flag ${flag}`)
      const value = argv[++i]
      if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
      scalars[flag] = value
    } else if (selectionFlags.has(flag)) {
      const values = selections[flag] ??= []
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        values.push(...argv[++i].split(',').map((item) => item.trim()).filter(Boolean))
      }
    } else {
      throw new Error(`Unknown launch argument ${flag}`)
    }
  }
  const entry = scalars['--workspace'] ?? workspaceFallback
  const binary = scalars['--binary']
  if (!entry || !binary) throw new Error('usage: launch --workspace <entry> --binary <absolute-codex-path> [--skills ...] [--inject ...] [--profile <locator>] [--inject-budget <bytes>] [--resume <thread-id-or-recipe>]')
  return { entry, binary, skills: selections['--skills'], inject: selections['--inject'], profile: scalars['--profile'], injectBudget: scalars['--inject-budget'] === undefined ? undefined : Number(scalars['--inject-budget']), resume: scalars['--resume'] }
}
