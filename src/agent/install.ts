import type { Stats } from 'node:fs'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { AGENTS, EVENTS, OWN_HOOK, SKILL, SKILL_MARKER, STATUS } from './constants'

type Agent = keyof typeof AGENTS
type HookEvent = typeof EVENTS[number]

interface HookEntry {
  matcher?: string
  hooks?: { type?: string, command?: unknown, timeout?: number, statusMessage?: string }[]
}
interface Settings { hooks?: Record<string, HookEntry[]> }

const base = (project: boolean): string => project ? process.cwd() : homedir()

export function configFile(agent: Agent, project: boolean): string {
  const { dir, file } = AGENTS[agent]
  return join(base(project), dir, file)
}

export function skillDir(agent: Agent, project: boolean): string {
  return join(base(project), AGENTS[agent].skills, SKILL)
}

export type HookCommands = Record<HookEvent, string>

// A project config is committed, so it names the package, not this machine's
// path to it. Single quotes keep the shell from expanding a `$` in the path.
//
// A missing package or a moved script exits 1. Before a tool call that lets
// the call run unchecked, so PreToolUse turns it into a block. At Stop a block
// means "keep going" and every retry fails the same way, so the agent could
// never stop: there it stays an error, which lets the reply stand.
export function hookCommands(script: string, project: boolean): HookCommands {
  const command = project ? 'npx --no-install shell-secrets hook' : `node '${script.replaceAll('\'', `'\\''`)}' hook`
  return { PreToolUse: `${command} || exit 2`, Stop: command }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

// Rewriting a file of another shape would drop what the agent reads from it,
// so it is refused before anything is written.
function readSettings(file: string): Settings {
  if (!existsSync(file)) {
    return {}
  }
  let settings: unknown
  try {
    settings = JSON.parse(readFileSync(file, 'utf8'))
  }
  catch (error) {
    throw new Error(`${file} is not valid JSON (${(error as Error).message}); it was left unchanged`)
  }
  // A `null` where the hooks object or an event's list would go is read as
  // absent, as the agents do, and the hook is written in; a wrong non-null
  // shape would lose what the agent reads, so it is refused.
  const hooks = isObject(settings) ? settings.hooks : undefined
  const wrongHooks = hooks !== undefined && hooks !== null && !isObject(hooks)
  const wrongList = isObject(hooks) && EVENTS.some(event => hooks[event] !== undefined && hooks[event] !== null && !Array.isArray(hooks[event]))
  if (!isObject(settings) || wrongHooks || wrongList) {
    throw new Error(`${file} does not hold a settings object with a hooks object and ${EVENTS.join(' and ')} lists; it was left unchanged`)
  }
  return settings as Settings
}

function isOwnHook(hook: { command?: unknown }): boolean {
  return typeof hook.command === 'string' && OWN_HOOK.test(hook.command)
}

// Drops any earlier shell-secrets entry first, so installing twice or after a
// move leaves exactly one hook per event pointing at the current build.
// Entries it does not understand are kept as they are.
export function configure(file: string, agent: Agent, commands: HookCommands | null): void {
  const settings = readSettings(file)
  const hooks = { ...settings.hooks }
  for (const event of EVENTS) {
    const kept = (Array.isArray(hooks[event]) ? hooks[event] : [])
      .map(entry => Array.isArray(entry?.hooks) ? { ...entry, hooks: entry.hooks.filter(h => !isOwnHook(h)) } : entry)
      .filter(entry => !Array.isArray(entry?.hooks) || entry.hooks.length > 0)
    if (commands)
      kept.push(hookEntry(agent, event, commands[event]))
    hooks[event] = kept
    if (kept.length === 0)
      delete hooks[event]
  }
  settings.hooks = hooks
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`)
}

function hookEntry(agent: Agent, event: HookEvent, command: string): HookEntry {
  const hooks = [{ type: 'command', command, timeout: 10, statusMessage: STATUS[event] }]
  return event === 'PreToolUse' ? { matcher: AGENTS[agent].matcher, hooks } : { hooks }
}

function entryAt(path: string): Stats | null {
  try {
    return lstatSync(path)
  }
  catch {
    return null
  }
}

// A link is never taken for the copy install made, whatever it points at.
function ownsSkill(dir: string): boolean {
  return entryAt(dir)?.isDirectory() === true && existsSync(join(dir, SKILL_MARKER))
}

export function assertSkillSource(source: string): void {
  if (!existsSync(join(source, 'SKILL.md')))
    throw new Error(`${source} holds no skill to install; run install from the published package or a checkout`)
}

/** Runs `step`, and puts `file` back as it was when `step` throws. */
export function keepingOnFailure<T>(file: string, step: () => T): T {
  const before = existsSync(file) ? readFileSync(file) : null
  try {
    return step()
  }
  catch (error) {
    if (before === null)
      rmSync(file, { force: true })
    else
      writeFileSync(file, before)
    throw error
  }
}

/**
 * Copies the skill in `source` to `target`, replacing an earlier copy. Returns
 * `false`, and writes nothing, when `target` holds something install did not
 * put there. The copy is staged and renamed in, so the agent never reads a
 * half-written skill.
 */
export function installSkill(source: string, target: string): boolean {
  assertSkillSource(source)
  if (entryAt(target) && !ownsSkill(target))
    return false
  mkdirSync(dirname(target), { recursive: true })
  // A fresh name, so a directory that only shares the staging name is never
  // the one copied into or removed.
  const staging = mkdtempSync(`${target}.`)
  try {
    cpSync(source, staging, { recursive: true })
    writeFileSync(join(staging, SKILL_MARKER), '')
    rmSync(target, { recursive: true, force: true })
    renameSync(staging, target)
  }
  finally {
    rmSync(staging, { recursive: true, force: true })
  }
  return true
}

/** Removes the skill install put in `target`. Returns `false` when something else is there. */
export function removeSkill(target: string): boolean {
  if (!entryAt(target))
    return true
  if (!ownsSkill(target))
    return false
  rmSync(target, { recursive: true, force: true })
  return true
}
