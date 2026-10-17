import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { AGENTS, OWN_HOOK } from './constants'

type Agent = keyof typeof AGENTS

interface HookEntry {
  matcher?: string
  hooks?: { type?: string, command?: unknown, timeout?: number, statusMessage?: string }[]
}
interface Settings { hooks?: Record<string, HookEntry[]> }

export function configFile(agent: Agent, project: boolean): string {
  const { dir, file } = AGENTS[agent]
  return join(project ? process.cwd() : homedir(), dir, file)
}

// A project config is committed, so it names the package, not this machine's
// path to it. A missing package or a moved script exits 1, which would let
// every call run, so that becomes a block. Single quotes keep the shell from
// expanding a `$` in the path.
export function hookCommand(script: string, project: boolean): string {
  const command = project ? 'npx --no-install shell-secrets hook' : `node '${script.replaceAll('\'', `'\\''`)}' hook`
  return `${command} || exit 2`
}

function isOwnHook(hook: { command?: unknown }): boolean {
  return typeof hook.command === 'string' && OWN_HOOK.test(hook.command)
}

// Drops any earlier shell-secrets entry first, so installing twice or after a
// move leaves exactly one hook pointing at the current build. Entries it does
// not understand are kept as they are.
export function configure(file: string, agent: Agent, command: string | null): void {
  const settings: Settings = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  const hooks = settings.hooks ?? {}
  const kept = (Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [])
    .map(entry => Array.isArray(entry?.hooks) ? { ...entry, hooks: entry.hooks.filter(h => !isOwnHook(h)) } : entry)
    .filter(entry => !Array.isArray(entry?.hooks) || entry.hooks.length > 0)
  if (command) {
    kept.push({
      matcher: AGENTS[agent].matcher,
      hooks: [{ type: 'command', command, timeout: 10, statusMessage: 'Scanning for secrets' }],
    })
  }
  settings.hooks = { ...hooks, PreToolUse: kept }
  if (kept.length === 0)
    delete settings.hooks.PreToolUse
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`)
}
