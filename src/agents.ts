import type { GuardEnv, ToolCall } from './guard'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { checkToolCall } from './guard'

const AGENTS = {
  claude: { dir: '.claude', file: 'settings.json', matcher: 'Bash|Write|Edit|MultiEdit|NotebookEdit' },
  codex: { dir: '.codex', file: 'hooks.json', matcher: 'Bash|apply_patch' },
} as const
type Agent = keyof typeof AGENTS

const USAGE = `Usage:
  shell-secrets install <claude|codex> [--project]   add the PreToolUse hook
  shell-secrets uninstall <claude|codex> [--project] remove it
  shell-secrets hook                                 run as the hook (reads the tool call on stdin)`

interface HookEntry {
  matcher?: string
  hooks?: { type?: string, command?: unknown, timeout?: number, statusMessage?: string }[]
}
interface Settings { hooks?: Record<string, HookEntry[]> }

/** What the command line needs from its process, passed in so tests can supply it. */
export interface CliIO {
  /** The tool call, read only by `hook`. */
  stdin: () => string
  /** The executable the installed hook runs. */
  script: string
}

/** Runs the `shell-secrets` command and returns its exit code. */
export function main(argv: string[], io: CliIO): number {
  const [command, agent, ...flags] = argv
  if (command === 'hook')
    return runHook(io.stdin())
  if ((command === 'install' || command === 'uninstall') && (agent === 'claude' || agent === 'codex')) {
    const file = configFile(agent, flags.includes('--project'))
    const project = flags.includes('--project')
    configure(file, agent, command === 'install' ? hookCommand(io.script, project) : null)
    process.stdout.write(`${command === 'install' ? 'Installed in' : 'Removed from'} ${file}\n`)
    if (command === 'install' && agent === 'codex')
      process.stdout.write('Codex runs a new hook only after you trust it: open /hooks in Codex once.\n')
    return 0
  }
  console.error(USAGE)
  return 1
}

function configFile(agent: Agent, project: boolean): string {
  const { dir, file } = AGENTS[agent]
  return join(project ? process.cwd() : homedir(), dir, file)
}

// A project config is committed, so it names the package, not this machine's
// path to it. Single quotes keep the shell from expanding a `$` in the path.
function hookCommand(script: string, project: boolean): string {
  return project ? 'npx --no-install shell-secrets hook' : `node '${script.replaceAll('\'', `'\\''`)}' hook`
}

const OWN_HOOK = /^(?:node .*shell-secrets.* |npx --no-install shell-secrets )hook$/

function isOwnHook(hook: { command?: unknown }): boolean {
  return typeof hook.command === 'string' && OWN_HOOK.test(hook.command)
}

// Drops any earlier shell-secrets entry first, so installing twice or after a
// move leaves exactly one hook pointing at the current build. Entries it does
// not understand are kept as they are.
function configure(file: string, agent: Agent, command: string | null): void {
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

// Claude Code and Codex share the hook protocol; they differ in tool names and
// in Codex's apply_patch, which carries a whole patch instead of one file.
function toToolCall(tool: unknown, input: Record<string, unknown>): ToolCall | null {
  const text = (key: string): string => typeof input[key] === 'string' ? input[key] : ''
  const edits = Array.isArray(input.edits) ? input.edits.map(record) : []
  const joined = (key: string): string => edits.map(edit => typeof edit[key] === 'string' ? edit[key] : '').join('\n')
  switch (tool) {
    case 'Bash':
      return { kind: 'shell', command: text('command') }
    case 'Write':
      return { kind: 'write', path: text('file_path'), content: text('content') }
    case 'Edit':
      return { kind: 'edit', path: text('file_path'), before: text('old_string'), after: text('new_string') }
    case 'MultiEdit':
      return { kind: 'edit', path: text('file_path'), before: joined('old_string'), after: joined('new_string') }
    case 'NotebookEdit':
      return { kind: 'write', path: text('notebook_path'), content: text('new_source') }
    case 'apply_patch':
      return { kind: 'patch', patch: text('command') || text('input') || text('patch') }
    default:
      return null
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

// Any exit other than 2 lets the call run, so a payload the hook cannot read
// blocks instead of passing unchecked.
function runHook(stdin: string): number {
  let findings
  try {
    const payload = record(JSON.parse(stdin))
    const call = toToolCall(payload.tool_name, record(payload.tool_input))
    if (!call)
      return 0
    findings = checkToolCall(call, gitEnv(typeof payload.cwd === 'string' ? payload.cwd : process.cwd()))
  }
  catch (error) {
    console.error(`Blocked by shell-secrets, it could not check the call: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
  if (findings.length === 0)
    return 0
  const list = findings.map(f => `${f.name} (${f.preview})${f.env ? `: use $${f.env}` : ''}`)
  console.error(`Blocked by shell-secrets, the call contains a secret:\n${list.join('\n')}\nReference it through an environment variable, or write it only to a gitignored file such as .env.`)
  return 2
}

const MAX_FORCED_FILES = 2000

function gitEnv(cwd: string): GuardEnv {
  return {
    // check-ignore answers no for a tracked file and for a path outside any
    // repository, so only an untracked, ignored file counts. It does not follow
    // links, so the file a write would really land in is the one asked about.
    isIgnored: (path) => {
      const full = landsIn(resolve(cwd, path))
      return full !== null && spawnSync('git', ['-C', dirname(full), 'check-ignore', '-q', basename(full)]).status === 0
    },
    readFile: (path) => {
      try {
        return readFileSync(expand(cwd, path), 'utf8')
      }
      catch {
        return null
      }
    },
    listIgnored: (path) => {
      const dir = expand(cwd, path)
      try {
        if (!statSync(dir).isDirectory())
          return null
      }
      catch {
        return null
      }
      const listed = spawnSync('git', ['-C', dir, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 16 << 20 })
      const files = listed.status === 0 ? listed.stdout.split('\0').filter(Boolean) : null
      // A forced add of a dependency or build tree is too big to scan inside a
      // hook's time budget, so it stays blocked as unscanned.
      return files && files.length <= MAX_FORCED_FILES ? files.map(file => join(dir, file)) : null
    },
  }
}

function expand(cwd: string, path: string): string {
  return resolve(cwd, path.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/)/, homedir()))
}

// The real path a write to `full` lands in, or `null` for a link whose target
// is missing, which a write would create wherever it points.
function landsIn(full: string): string | null {
  try {
    return realpathSync(full)
  }
  catch {
    try {
      if (lstatSync(full).isSymbolicLink())
        return null
    }
    catch {}
    try {
      return join(realpathSync(dirname(full)), basename(full))
    }
    catch {
      return full
    }
  }
}
