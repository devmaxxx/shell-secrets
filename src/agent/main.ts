import { join } from 'node:path'
import process from 'node:process'
import { SKILL, USAGE } from './constants'
import { runHook } from './hook'
import { assertSkillSource, configFile, configure, copyBuild, hookCommands, installSkill, keepingOnFailure, removeSkill, skillDir } from './install'

/** What the command line needs from its process, passed in so tests can supply it. */
export interface CliIO {
  /** The tool call, read only by `hook`. */
  stdin: () => string
  /** The executable the installed hook runs. */
  script: string
  /** The directory holding the skills `install` copies, `skills/` in the package. */
  skills: string
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
  // Removing the hook needs no check, so `uninstall` still runs. At Stop it
  // stays an error, which lets the reply stand: a block there would keep the
  // agent from ever stopping.
  const major = Number(/^v(\d+)\./.exec(io.node)?.[1] ?? 0)
  if ((command === 'hook' || command === 'install') && major < 22) {
    console.error(`shell-secrets needs Node.js 22 or later, and the node on PATH is ${io.node}. Run \`npx shell-secrets install claude\` (or codex) again with Node.js 22 or later, or put one first on PATH and restart the agent.`)
    return command === 'hook' && !isStop(io.stdin) ? 2 : 1
  }
  if (command === 'hook')
    return runHook(io.stdin)
  if ((command === 'install' || command === 'uninstall') && (agent === 'claude' || agent === 'codex')) {
    const project = flags.includes('--project')
    const file = configFile(agent, project)
    const skill = skillDir(agent, project)
    const source = join(io.skills, SKILL)
    let ours: boolean
    try {
      if (command === 'install') {
        // A failed skill step undoes the hooks, so install is all or nothing.
        assertSkillSource(source)
        const commands = hookCommands(project ? '' : copyBuild(io.script), project, io.execPath)
        ours = keepingOnFailure(file, () => {
          configure(file, agent, commands)
          return installSkill(source, skill)
        })
      }
      else {
        configure(file, agent, null)
        ours = removeSkill(skill)
      }
    }
    catch (error) {
      console.error(`shell-secrets: ${(error as Error).message}`)
      return 1
    }
    process.stdout.write(`${command === 'install' ? 'Installed in' : 'Removed from'} ${file}${ours ? ` and ${skill}` : ''}\n`)
    // The hook works without the skill, so a skill of the same name the user
    // keeps is left in place with a note rather than failing the install.
    if (!ours)
      console.error(`shell-secrets: left ${skill} as it is, since shell-secrets did not install it`)
    if (command === 'install' && agent === 'codex')
      process.stdout.write('Codex runs a new hook only after you trust it: open /hooks in Codex once.\n')
    return 0
  }
  console.error(USAGE)
  return 1
}

function isStop(stdin: () => string): boolean {
  try {
    return JSON.parse(stdin())?.hook_event_name === 'Stop'
  }
  catch {
    return false
  }
}
