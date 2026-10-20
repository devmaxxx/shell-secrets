import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import process from 'node:process'
import { AGENTS, OWN_HOOK } from './constants'

type Agent = keyof typeof AGENTS

interface HookEntry {
  matcher?: string
  hooks?: { type?: string, command?: unknown, timeout?: number, statusMessage?: string, onFailure?: string }[]
}
interface Settings { hooks?: Record<string, HookEntry[]> }

export function configFile(agent: Agent, project: boolean): string {
  const { dir, file } = AGENTS[agent]
  return join(project ? process.cwd() : homedir(), dir, file)
}

const quote = (word: string): string => `'${word.replaceAll('\'', `'\\''`)}'`

// A project config is committed, so it names the package, not this machine's
// path to it. A missing package or a moved script exits 1, which would let
// every call run, so that becomes a block. Single quotes keep the shell from
// expanding a `$` in the path.
//
// A global hook runs on the Node.js that installed it, not on the `node` first
// on PATH, which a project pinning an older version would change under every
// session. Once that Node.js is removed it falls back to PATH, and `main`
// blocks there with a message when that one is too old.
export function hookCommand(script: string, project: boolean, node: string): string {
  if (project)
    return 'npx --no-install shell-secrets hook || exit 2'
  return `n=${quote(node)}; [ -x "$n" ] || n=node; "$n" ${quote(script)} hook || exit 2`
}

const builtFiles = (dir: string): string[] => readdirSync(dir).filter(name => name.endsWith('.mjs')).sort()

function buildId(dir: string): string {
  const hash = createHash('sha256')
  for (const name of builtFiles(dir))
    hash.update(name).update('\0').update(readFileSync(join(dir, name)))
  return hash.digest('hex').slice(0, 12)
}

// A global hook outlives the copy of the package that installed it: an nvm or
// Homebrew Node upgrade deletes the old version's global packages, and a
// rebuild of a checkout would change the rules under every running session.
// So the hook runs its own copy of this build, in a directory named after the
// build's content: reinstalling the same build reuses it, a new build gets a
// new one, and an entry another agent still points at is never overwritten.
// The copy is staged and renamed in, so a hook never loads a half-written one,
// and a directory whose content no longer matches its name is copied again.
// The hook runs it through the `current` link, swapped by a rename, so the
// command stays the same between versions installed by the same Node.js:
// Codex re-reviews a changed command and skips the hook until it is trusted.
// The build `current` names must stay, or every call blocks until the next
// install.
export function copyBuild(script: string): string {
  if (!script.endsWith('.mjs') || !existsSync(script))
    throw new Error(`${script} is not a built shell-secrets entry; run install from the published package or a build`)
  const source = dirname(script)
  const id = buildId(source)
  const root = join(homedir(), '.shell-secrets')
  const target = join(root, id)
  if (!existsSync(target) || buildId(target) !== id) {
    mkdirSync(root, { recursive: true })
    const staging = mkdtempSync(`${target}-`)
    try {
      for (const name of builtFiles(source))
        copyFileSync(join(source, name), join(staging, name))
      // A concurrent install of this build may have renamed its copy in while
      // this one staged; that copy may already be in use, so it is kept.
      if (existsSync(target) && buildId(target) !== id)
        renameSync(target, `${staging}-stale`)
      if (!existsSync(target))
        renameSync(staging, target)
    }
    catch (error) {
      // Another install of the same build got there first.
      if (!existsSync(target) || buildId(target) !== id)
        throw error
    }
    finally {
      rmSync(staging, { recursive: true, force: true })
      rmSync(`${staging}-stale`, { recursive: true, force: true })
    }
  }
  const current = join(root, 'current')
  if (existsSync(current) && !lstatSync(current).isSymbolicLink())
    throw new Error(`${current} is not the link install writes; move it away and install again`)
  const link = `${current}.${process.pid}`
  try {
    rmSync(link, { force: true })
    symlinkSync(id, link)
    renameSync(link, current)
  }
  finally {
    rmSync(link, { force: true })
  }
  return join(current, basename(script))
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
  // A `null` where the hooks object or the PreToolUse list would go is read as
  // absent, as the agents do, and the hook is written in; a wrong non-null
  // shape would lose what the agent reads, so it is refused.
  const hooks = isObject(settings) ? settings.hooks : undefined
  const preToolUse = isObject(hooks) ? hooks.PreToolUse : undefined
  const wrongHooks = hooks !== undefined && hooks !== null && !isObject(hooks)
  const wrongPreToolUse = preToolUse !== undefined && preToolUse !== null && !Array.isArray(preToolUse)
  if (!isObject(settings) || wrongHooks || wrongPreToolUse) {
    throw new Error(`${file} does not hold a settings object with a hooks object and a PreToolUse list; it was left unchanged`)
  }
  return settings as Settings
}

function isOwnHook(hook: { command?: unknown }): boolean {
  return typeof hook.command === 'string' && OWN_HOOK.test(hook.command)
}

// Drops any earlier shell-secrets entry first, so installing twice or after a
// move leaves exactly one hook pointing at the current build. Entries it does
// not understand are kept as they are.
export function configure(file: string, agent: Agent, command: string | null): void {
  const settings = readSettings(file)
  const hooks = settings.hooks ?? {}
  const kept = (Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [])
    .map(entry => Array.isArray(entry?.hooks) ? { ...entry, hooks: entry.hooks.filter(h => !isOwnHook(h)) } : entry)
    .filter(entry => !Array.isArray(entry?.hooks) || entry.hooks.length > 0)
  if (command) {
    kept.push({
      matcher: AGENTS[agent].matcher,
      // Claude Code also blocks the call when the hook cannot start or times
      // out, which `|| exit 2` cannot see. Codex has no such field.
      hooks: [{ type: 'command', command, timeout: 10, statusMessage: 'Scanning for secrets', ...(agent === 'claude' ? { onFailure: 'block' } : {}) }],
    })
  }
  settings.hooks = { ...hooks, PreToolUse: kept }
  if (kept.length === 0)
    delete settings.hooks.PreToolUse
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`)
}
