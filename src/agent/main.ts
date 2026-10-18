import process from 'node:process'
import { USAGE } from './constants'
import { runHook } from './hook'
import { configFile, configure, hookCommand } from './install'

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
    return runHook(io.stdin)
  if ((command === 'install' || command === 'uninstall') && (agent === 'claude' || agent === 'codex')) {
    const project = flags.includes('--project')
    const file = configFile(agent, project)
    try {
      configure(file, agent, command === 'install' ? hookCommand(io.script, project) : null)
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
