import type { CommandFinding, CommandScan, ScanOptions } from './types'
import { findSecrets } from './scan'
import { hasSubstitution, runsCommand, scrubShell } from './shell'

/**
 * Targets a command writes through `>`, `>>` or `tee`. Only the plain forms
 * are read; anything fancier is left out, so a caller that allows a write only
 * when it can name every target stays on the strict side.
 */
function redirectTargets(cmd: string): string[] {
  const targets: string[] = []
  for (const m of cmd.matchAll(/(?<![<>&\d=-])>{1,2}\s*(["']?)([^\s"'|;&>]+)\1/g)) {
    targets.push(m[2]!)
  }
  for (const m of cmd.matchAll(/\btee\b([^|;&<>\n]*)/g)) {
    for (const word of m[1]!.split(/\s+/)) {
      const operand = word.replace(/^["']|["']$/g, '')
      if (operand && !operand.startsWith('-')) {
        targets.push(operand)
      }
    }
  }
  return targets.filter(t => !t.startsWith('/dev/'))
}

/**
 * A lone `echo`, `printf` or `cat`, optionally piped into `tee`: the only
 * shapes whose whole effect is their redirect targets. Anything chained,
 * substituted or piped elsewhere can put the same text somewhere else, so it
 * never qualifies. Judged on the scrubbed line, where quoted text and heredoc
 * bodies cannot pose as operators.
 */
function isLoneWrite(cmd: string): boolean {
  if (hasSubstitution(cmd)) {
    return false
  }
  const line = scrubShell(cmd).replace(/\d?>&\d|\d>\s*\/dev\/null/g, '').trim()
  if (/[;&`\n]|\d>|[<>]\(/.test(line)) {
    return false
  }
  const [head = '', ...pipes] = line.split('|')
  return (
    /^(?:echo|printf|cat)\b/.test(head)
    && pipes.every(stage => /^\s*tee\b/.test(stage))
  )
}

/** A path whose shell expansion cannot be predicted is not one a caller can vouch for. */
function isLiteralPath(path: string): boolean {
  return !/[~$`*?[{]/.test(path)
}

const MESSAGE_FILE_FLAG
  = /(?:^|\s)(?:-F|--file|--body-file)[=\s]+(?:"([^"]+)"|'([^']+)'|([^\s"']+))/g

function messageFiles(cmd: string): string[] {
  if (!runsCommand(scrubShell(cmd), 'git|gh')) {
    return []
  }
  return [...cmd.matchAll(MESSAGE_FILE_FLAG)]
    .map(m => (m[1] ?? m[2] ?? m[3])!)
    .filter(path => path !== '-' && !/[$`]/.test(path))
}

// `&` and `;` are left out of the boundary: unspaced, they are far more often a
// URI's `&password=` or a JDBC `;password=` than a shell operator.
const ASSIGNMENT_BEFORE = /(?:^|[\s("'])([A-Z_]\w*)=["']?$/i
const ASSIGNMENT_LOOKBEHIND = 256

function assignedVariable(cmd: string, start: number): string | undefined {
  const before = cmd.slice(Math.max(0, start - ASSIGNMENT_LOOKBEHIND), start)
  return ASSIGNMENT_BEFORE.exec(before)?.[1]
}

/**
 * Scans a shell command line: the secrets it carries literally, the files it
 * writes, and the files `git` / `gh` would publish from disk.
 *
 * @example
 * ```ts
 * const { findings, messageFiles } = findSecretsInCommand('git commit -F msg.txt')
 * const inFiles = messageFiles.flatMap(f => findSecrets(readFileSync(f, 'utf8')))
 * ```
 */
export function findSecretsInCommand(cmd: string, options: ScanOptions = {}): CommandScan {
  if (typeof cmd !== 'string') {
    return { findings: [], redirectTargets: [], messageFiles: [] }
  }
  const findings: CommandFinding[] = findSecrets(cmd, options).map((finding) => {
    const variable = assignedVariable(cmd, finding.start)
    return variable ? { ...finding, variable } : finding
  })
  return { findings, redirectTargets: redirectTargets(cmd), messageFiles: messageFiles(cmd) }
}

/**
 * True when the command's whole effect is writing to files, and `accept`
 * approves every one of them — e.g. "only gitignored `.env` files".
 *
 * Only a lone `echo`, `printf` or `cat` with `>`, `>>` or `| tee` qualifies.
 * A chained, substituted or otherwise piped command never does, nor does one
 * whose target holds `~`, `$`, a glob or a backtick, because its expansion
 * cannot be predicted; `accept` is not called for those.
 */
export function onlyWritesTo(cmd: string, accept: (path: string) => boolean): boolean {
  if (typeof cmd !== 'string' || !isLoneWrite(cmd)) {
    return false
  }
  const targets = redirectTargets(cmd)
  return targets.length > 0 && targets.every(t => isLiteralPath(t) && accept(t))
}
