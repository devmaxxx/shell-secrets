import type { CommandFinding, CommandScan, ScanOptions } from './types'
import { findSecrets } from './scan'
import { COMMAND_PREFIX, hasSubstitution, scrubShell, segments, unquote, wordAt } from './shell'

// Only the devices that cannot carry data off the machine. `/dev/tcp/…` and
// `/dev/udp/…` are bash network sockets, and `/dev/../x` is an ordinary file.
const HARMLESS_DEVICE = /^\/dev\/(?:null|zero|full|stdout|stderr|tty)$/

// `>`, `>>`, `>|`, `&>`, `>&file` with an optional fd; `>&2` and `>&-` only
// duplicate or close a descriptor and name no file.
const REDIRECT = /(?:\d+|&)?>(?:>|\||&(?![\d-]))?(?!&[\d-])\s*/g
const TEE = new RegExp(`^\\s*${COMMAND_PREFIX}tee(?=\\s|$)`)
const BLANKS = /[ \t]*/y
const REDIRECT_OPERATOR = /[<>]+[&|]?/y

function skipBlanks(cmd: string, at: number): number {
  BLANKS.lastIndex = at
  return at + BLANKS.exec(cmd)![0].length
}

interface Target { readonly at: number, readonly path: string }

/**
 * Every file the command writes through a redirect or `tee`, in order. The
 * operators are found on the scrubbed line, so a `>` or `tee` inside quotes is
 * not one; the operand is read from the original, so a quoted path keeps its
 * spaces. An operand that cannot be read is `''`.
 */
function writeTargets(cmd: string, scrubbed: string): Target[] {
  const targets: Target[] = []
  for (const m of scrubbed.matchAll(REDIRECT)) {
    const at = m.index + m[0].length
    targets.push({ at, path: unquote(wordAt(cmd, at)) })
  }
  for (const { start, text } of segments(scrubbed)) {
    const tee = TEE.exec(text)
    if (!tee) {
      continue
    }
    let at = start + tee[0].length
    let options = true
    for (;;) {
      at = skipBlanks(cmd, at)
      const word = wordAt(cmd, at)
      if (!word) {
        // A redirect among the operands names no tee target; skip it and read on.
        REDIRECT_OPERATOR.lastIndex = at
        const operator = REDIRECT_OPERATOR.exec(cmd)
        if (!operator) {
          break
        }
        at = skipBlanks(cmd, at + operator[0].length)
        at += wordAt(cmd, at).length
      }
      else if (/^\d+$/.test(word) && /[<>]/.test(cmd[at + word.length] ?? '')) {
        at += word.length
      }
      else {
        if (options && word === '--') {
          options = false
        }
        else if (!options || !word.startsWith('-')) {
          targets.push({ at, path: unquote(word) })
        }
        at += word.length
      }
    }
  }
  return targets
    .filter(t => !HARMLESS_DEVICE.test(t.path))
    .sort((a, b) => a.at - b.at)
}

/**
 * A lone `echo`, `printf` or `cat`, optionally piped into `tee`: the only
 * shapes whose whole effect is their redirect targets. Anything chained,
 * substituted or piped elsewhere can put the same text somewhere else, so it
 * never qualifies.
 */
function isLoneWrite(cmd: string, scrubbed: string): boolean {
  if (hasSubstitution(cmd)) {
    return false
  }
  const line = scrubbed
    .replace(/\d?>&\d(?![\w-])|\d>\s*\/dev\/null(?![^\s|<>])/g, '')
    .trim()
  if (/[;&`\n]|\d>|[<>]\(/.test(line)) {
    return false
  }
  const [head = '', ...pipes] = line.split('|')
  return (
    /^(?:echo|printf|cat)(?=\s|$)/.test(head)
    && pipes.every(stage => /^\s*tee(?=\s|$)/.test(stage))
  )
}

/** A path whose shell expansion cannot be predicted is not one a caller can vouch for. */
function isLiteralPath(path: string): boolean {
  return path !== '' && !/[~$`*?[{]/.test(path)
}

// Global options such as `-C dir` or `--no-pager` may sit between `git` and
// its subcommand. `gh api -F` is a form field and `git grep -F` a fixed
// string, so only the subcommands that publish a file are read.
const PUBLISHES_FILE = new RegExp(
  `^\\s*${COMMAND_PREFIX}(?:git(?:\\s+-\\S+(?:\\s+[^-\\s]\\S*)?)*?\\s+(?:commit|tag|notes|merge)|gh\\s+(?:pr|issue|release))(?![\\w-])`,
)
// `-F` may be bundled (`-aF msg`) or glued to its value (`-Fmsg`).
const MESSAGE_FILE_FLAG = /(?<=^|\s)(?:-[A-Za-z]*?F|--(?:file|body-file|notes-file)(?=[=\s]))=?\s*/g

// A path with `$` or a backtick is kept verbatim, like a redirect target: the
// caller cannot read it, and silently dropping it would read as "no file".
function messageFiles(cmd: string, scrubbed: string): string[] {
  return segments(scrubbed)
    .filter(segment => PUBLISHES_FILE.test(segment.text))
    .flatMap(({ start, text }) =>
      [...text.matchAll(MESSAGE_FILE_FLAG)].map(m => unquote(wordAt(cmd, start + m.index + m[0].length))))
    .filter(path => path !== '' && path !== '-')
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
  const scrubbed = scrubShell(cmd)
  return {
    findings,
    redirectTargets: writeTargets(cmd, scrubbed).map(t => t.path).filter(path => path !== ''),
    messageFiles: messageFiles(cmd, scrubbed),
  }
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
  if (typeof cmd !== 'string') {
    return false
  }
  const scrubbed = scrubShell(cmd)
  if (!isLoneWrite(cmd, scrubbed)) {
    return false
  }
  const targets = writeTargets(cmd, scrubbed)
  return targets.length > 0 && targets.every(t => isLiteralPath(t.path) && accept(t.path))
}
