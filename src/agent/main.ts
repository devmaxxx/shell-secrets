import process from 'node:process'
import { USAGE } from './constants'
import { runHook } from './hook'
import { configFile, configure, copyBuild, hookCommand } from './install'

/** What the command line needs from its process, passed in so tests can supply it. */
export interface CliIO {
  /** The tool call, read only by `hook`. */
  stdin: () => string
  /** The executable the installed hook runs. */
  script: string
  /** The running Node.js version, as `process.version` gives it. */
  node: string
  /** The running Node.js executable, which a global hook keeps running on. */
  execPath: string
}

/** Runs the `shell-secrets` command and returns its exit code. */
export function main(argv: string[], io: CliIO): number {
  const [command, agent, ...flags] = argv
  // The global hook falls back to the `node` first on PATH once the Node.js
  // that installed it is gone, so an older one can reach it. Nothing below 22
  // is tested, and a check that misbehaves there could let a secret through,
  // so it blocks and says why.
  // Removing the hook needs no check, so `uninstall` still runs.
  const major = Number(/^v(\d+)\./.exec(io.node)?.[1] ?? 0)
  if ((command === 'hook' || command === 'install') && major < 22) {
    console.error(`shell-secrets needs Node.js 22 or later, and the node on PATH is ${io.node}. Run \`npx shell-secrets install claude\` (or codex) again with Node.js 22 or later, or put one first on PATH and restart the agent.`)
    return command === 'hook' ? 2 : 1
  }
  if (command === 'hook')
    return runHook(io.stdin)
  if ((command === 'install' || command === 'uninstall') && (agent === 'claude' || agent === 'codex')) {
    const project = flags.includes('--project')
    const file = configFile(agent, project)
    try {
      configure(file, agent, command === 'install' ? hookCommand(project ? '' : copyBuild(io.script), project, io.execPath) : null)
    }
    catch (error) {
      console.error(`shell-secrets: ${(error as Error).message}`)
      return 1
    }
    process.stdout.write(`${command === 'install' ? 'Installed in' : 'Removed from'} ${file}\n`)
    if (command === 'install' && agent === 'codex')
      process.stdout.write('Codex runs a new hook only after you trust it: open /hooks in Codex once.\n')
    return 0
  }
  console.error(USAGE)
  return 1
}
