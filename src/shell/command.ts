import type { CommandFinding, CommandScan, ScanOptions } from '../types'
import { findSecrets } from '../scan/find'
import { ADDS_ALL, ASSIGNMENT_BEFORE, ASSIGNMENT_LOOKBEHIND, BLANKS, CHANGES_DIRECTORY, EXPANDED_INLINE_INPUT, FILE_READER, FORCED_ADD, GIT_DIR_OPTION, HARMLESS_DEVICE, HEREDOC_INTO_CAT, INPUT_REDIRECT, LINE_COUNT, LITERAL_STDIN, MESSAGE_FILE_FLAG, PATHSPEC_FILE, PUBLISHES_FILE, REDIRECT, REDIRECT_OPERATOR, TEE } from './constants'
import { hasSubstitution, scrubShell, segments, unquote, wordAt } from './parse'

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
  // `>|` is a redirect that overrides noclobber, not a pipe.
  const line = scrubbed
    .replace(/\d?>&\d(?![\w-])|\d>\s*\/dev\/null(?![^\s|<>])/g, '')
    .replace(/>\|/g, '> ')
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

interface Segment { readonly start: number, readonly text: string }

/**
 * Where `messageFiles` leads: files to read, and the sources a command
 * publishes that cannot be pinned to one file, which the caller must treat as
 * unscanned.
 */
interface Published { files: string[], unresolved: string[] }

const publishes = (files: string[] = [], unresolved: string[] = []): Published => ({ files, unresolved })

/** The operands after `at` that are not options, as the shell would pass them. */
function operands(cmd: string, at: number, end: number): string[] {
  const words: string[] = []
  let options = true
  for (let i = skipBlanks(cmd, at); i < end; i = skipBlanks(cmd, i)) {
    const word = wordAt(cmd, i)
    if (!word)
      break
    if (options && word === '--')
      options = false
    else if (!options || !word.startsWith('-'))
      words.push(unquote(word))
    i += word.length
  }
  return words
}

function inputRedirects(cmd: string, segment: Segment): string[] {
  return [...segment.text.matchAll(INPUT_REDIRECT)]
    .map(m => unquote(wordAt(cmd, segment.start + m.index + m[0].length)))
}

// `--body-file -` reads stdin. A heredoc, a here-string or an echo puts the
// text in the command itself, which is scanned already; a file fed in through
// `<` or `cat file |` is published as surely as one named outright. Any other
// stage piped in (`tee`, `sed`, a subshell) is a source this cannot read.
const textOf = (cmd: string, segment: Segment): string => cmd.slice(segment.start, segment.start + segment.text.length)

function isPipedFrom(scrubbed: string, segment: Segment, previous: Segment | undefined): previous is Segment {
  return previous !== undefined && /(?<!\|)\|(?!\|)/.test(scrubbed.slice(previous.start + previous.text.length, segment.start))
}

// Text the shell passes on unexpanded: an `echo` or `printf` with no `$` or
// backtick, a heredoc into `cat` whose delimiter is quoted or whose body has
// neither, or a `tee` fed by one of those. Its words are in the command, and
// scanned with it.
function isLiteralStage(cmd: string, scrubbed: string, stage: Segment, all: readonly Segment[]): boolean {
  const original = textOf(cmd, stage)
  if (TEE.test(stage.text)) {
    const before = all[all.indexOf(stage) - 1]
    return isPipedFrom(scrubbed, stage, before) && isLiteralStage(cmd, scrubbed, before, all)
  }
  if (LITERAL_STDIN.test(stage.text))
    return !/[$`]/.test(original)
  const heredoc = HEREDOC_INTO_CAT.exec(original)
  return heredoc !== null && (heredoc.groups?.quote !== '' || !/[$`]/.test(original))
}

function stdinSource(cmd: string, scrubbed: string, segment: Segment, all: readonly Segment[]): Published {
  const previous = all[all.indexOf(segment) - 1]
  const redirected = inputRedirects(cmd, segment)
  if (redirected.length > 0)
    return publishes(redirected)
  if (!isPipedFrom(scrubbed, segment, previous)) {
    const original = textOf(cmd, segment)
    return EXPANDED_INLINE_INPUT.test(original) && /[$`]/.test(original)
      ? publishes([], [original.trim()])
      : publishes()
  }
  if (isLiteralStage(cmd, scrubbed, previous, all))
    return publishes()
  const reader = FILE_READER.exec(previous.text)
  const files = reader
    ? [
        ...operands(cmd, previous.start + reader[0].length, previous.start + previous.text.length).filter(word => !LINE_COUNT.test(word)),
        ...inputRedirects(cmd, previous),
      ]
    : []
  return files.length > 0 ? publishes(files) : publishes([], [cmd.slice(previous.start, segment.start + segment.text.length).trim()])
}

function forcedAdd(cmd: string, segment: Segment, add: RegExpExecArray): Published {
  const flags = segment.text.slice(add[0].length).split(/\s+/)
  if (!flags.some(word => /^(?:--force|-[A-EG-Z]*F[A-Z]*)$/i.test(word)))
    return publishes()
  if (flags.some(word => PATHSPEC_FILE.test(word)))
    return publishes([], [segment.text.trim()])
  const files = operands(cmd, segment.start + add[0].length, segment.start + segment.text.length)
  if (files.length === 0)
    return publishes(flags.some(word => ADDS_ALL.test(word)) ? ['.'] : [])
  return publishes(files)
}

// Each `-F` / `--body-file` names a file, or `-` for stdin.
function flaggedFiles(cmd: string, scrubbed: string, segment: Segment, all: readonly Segment[]): Published {
  const sources = [...segment.text.matchAll(MESSAGE_FILE_FLAG)].map((m) => {
    const path = unquote(wordAt(cmd, segment.start + m.index + m[0].length))
    return path === '-' ? stdinSource(cmd, scrubbed, segment, all) : publishes([path])
  })
  return publishes(sources.flatMap(s => s.files), sources.flatMap(s => s.unresolved))
}

/**
 * The files git and gh publish verbatim, and `git add -f` stages: .gitignore
 * keeps those out, so it is how a secret written to .env reaches a commit.
 *
 * A path with `$` or a backtick is kept verbatim, like a redirect target: the
 * caller cannot read it, and silently dropping it would read as "no file".
 * After a `cd`, or under `git -C`, a relative path names a file this cannot
 * place. A file the command writes first is left out when the writer is a
 * literal `echo` or `printf`, whose text is scanned as part of the command;
 * written any other way, its contents are unknown until the command runs.
 */
function messageFiles(cmd: string, scrubbed: string): Published {
  const all = segments(scrubbed).filter(segment => segment.text.trim() !== '')
  const writes = writeTargets(cmd, scrubbed)
  const published = publishes()
  let moved = false
  all.forEach((segment, index) => {
    const { start, text } = segment
    if (CHANGES_DIRECTORY.test(text)) {
      moved = true
      return
    }
    const add = FORCED_ADD.exec(text)
    const found = add
      ? forcedAdd(cmd, segment, add)
      : PUBLISHES_FILE.test(text) ? flaggedFiles(cmd, scrubbed, segment, all) : publishes()
    const elsewhere = moved || GIT_DIR_OPTION.test(` ${text}`)
    for (const path of found.files.filter(path => path !== '' && path !== '-')) {
      const writer = writes.filter(t => t.path === path && t.at < start).at(-1)
      if (all.slice(0, index).some(before => mayChange(cmd, before, path)))
        published.unresolved.push(path)
      else if (writer)
        isLiteralWrite(cmd, scrubbed, all, writer) || published.unresolved.push(path)
      else if (elsewhere && !/^[/~]/.test(path))
        published.unresolved.push(path)
      else
        published.files.push(path)
    }
    published.unresolved.push(...found.unresolved)
  })
  return published
}

function isLiteralWrite(cmd: string, scrubbed: string, all: readonly Segment[], target: Target): boolean {
  const writer = all.filter(segment => segment.start <= target.at).at(-1)
  return writer !== undefined && isLiteralStage(cmd, scrubbed, writer, all)
}

const normalise = (path: string): string => path.replace(/^(?:\.\/)+/, '')

// `cp .env msg && git commit -F msg`: a command that names the file can change
// it, so neither the disk's bytes nor an earlier literal write are what gets
// published. A reader, a `tee` (whose writes are tracked) and another publisher
// leave it as it is.
function mayChange(cmd: string, segment: Segment, path: string): boolean {
  if (FILE_READER.test(segment.text) || TEE.test(segment.text) || PUBLISHES_FILE.test(segment.text) || FORCED_ADD.test(segment.text))
    return false
  return operands(cmd, segment.start, segment.start + segment.text.length).some(word => normalise(word) === normalise(path))
}

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
    return { findings: [], redirectTargets: [], messageFiles: [], unresolvedSources: [] }
  }
  const findings: CommandFinding[] = findSecrets(cmd, options).map((finding) => {
    const variable = assignedVariable(cmd, finding.start)
    return variable ? { ...finding, variable } : finding
  })
  const scrubbed = scrubShell(cmd)
  const published = messageFiles(cmd, scrubbed)
  return {
    findings,
    redirectTargets: writeTargets(cmd, scrubbed).map(t => t.path).filter(path => path !== ''),
    messageFiles: published.files,
    unresolvedSources: published.unresolved,
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
