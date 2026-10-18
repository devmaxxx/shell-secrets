import type { CommandFinding, CommandScan, ScanOptions } from '../types'
import type { Segment } from './parse'
import type { Publication } from './publish'
import { findSecrets } from '../scan/find'
import { ASSIGNMENT_BEFORE, ASSIGNMENT_LOOKBEHIND, CHANGES_DIRECTORY, DEFINES_FUNCTION, EXPANDED_INLINE_INPUT, EXPANDS_VARIABLE, FILE_READER, HARMLESS_DEVICE, HARMLESS_REDIRECT, HEREDOC_INTO_CAT, INPUT_REDIRECT, LINE_COUNT, LITERAL_STDIN, MAX_COMMAND_LENGTH, MAX_SCRIPT_DEPTH, READS_INTO_VARIABLE, REDIRECT, REDIRECT_OPERATOR, TEE } from './constants'
import { hasSubstitution, scrubShell, segments, skipBlanks, unquote, wordAt } from './parse'
import { opaqueSubstitutionAt, printedText, publicationOf } from './publish'

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
  const all = segments(scrubbed)
  const byStart = new Map(all.map(segment => [segment.start, segment]))
  // `2>&1` and `&>f` split the line at their `&`, but the command goes on.
  const commandEnd = (segment: Segment): number => {
    let end = segment.start + segment.text.length
    while (scrubbed[end] === '&' && (/[<>]/.test(scrubbed[end - 1]!) || scrubbed[end + 1] === '>')) {
      const next = byStart.get(end + 1)
      if (!next) {
        break
      }
      end = next.start + next.text.length
    }
    return end
  }
  for (const segment of all) {
    const tee = TEE.exec(segment.text)
    if (!tee) {
      continue
    }
    let at = segment.start + tee[0].length
    let options = true
    // A word is read up to here: a backquote that closes the substitution this
    // command is in would otherwise open a span that runs into the next one.
    const end = commandEnd(segment)
    for (;;) {
      at = skipBlanks(cmd, at)
      if (at >= end) {
        break
      }
      const word = wordAt(cmd, at, end)
      if (!word) {
        // A redirect among the operands names no tee target; skip it and read on.
        REDIRECT_OPERATOR.lastIndex = at
        const operator = REDIRECT_OPERATOR.exec(cmd)
        if (!operator) {
          break
        }
        at = skipBlanks(cmd, at + operator[0].length)
        at += wordAt(cmd, at, end).length
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
    .replace(HARMLESS_REDIRECT, '')
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
    const word = wordAt(cmd, i, end)
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
    .map(m => unquote(wordAt(cmd, segment.start + m.index + m[0].length, segment.start + segment.text.length)))
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

// `echo 'git add -f .env' | bash` runs the echoed text. A script piped from a
// file or a download is beyond what the command line shows.
function pipedScript(cmd: string, scrubbed: string, all: readonly Segment[], index: number, publication: Publication): string[] {
  const previous = all[index - 1]
  if (!publication.stdinScript || !isPipedFrom(scrubbed, all[index]!, previous)) {
    return []
  }
  const text = printedText(cmd, previous)
  return text === null ? [] : [text]
}

const normalise = (path: string): string => path.replace(/^(?:\.\/)+/, '')

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
 * Shell code run through `bash -c`, `eval`, a heredoc or a runner such as
 * `su -c`, `env -S` or `watch` is read the same way.
 */
function messageFiles(cmd: string, scrubbed: string, depth = 0, tainted = false): Published {
  const all = segments(scrubbed).filter(segment => segment.text.trim() !== '')
  const found = all.map(segment => publicationOf(cmd, scrubbed, segment))
  const writes = writeTargets(cmd, scrubbed)
  const published = publishes()
  const hidden = hiddenContent(cmd, scrubbed, tainted)
  // `cp .env msg && git commit -F msg`, `dd of=msg` or a script that writes
  // 'msg': a command that mentions the file can change it, so neither the
  // disk's bytes nor an earlier literal write are what gets published. A
  // reader, a `tee` and a literal echo write only through redirects, which are
  // tracked. Built once: a long command line asks about many paths.
  let changers: (string | null)[] | undefined
  const changedBefore = (index: number, path: string): boolean => {
    changers ??= all.map((segment, i) => found[i]!.publishes || FILE_READER.test(segment.text) || TEE.test(segment.text) || isLiteralStage(cmd, scrubbed, segment, all) ? null : textOf(cmd, segment))
    const name = normalise(path).split('/').filter(Boolean).at(-1) ?? path
    for (let i = 0; i < index; i++) {
      // A command that holds this one in a substitution has not run yet.
      if (all[i]!.start + all[i]!.text.length <= all[index]!.start && changers[i]?.includes(name))
        return true
    }
    return false
  }
  let moved = false
  all.forEach((segment, index) => {
    const { start, text } = segment
    if (CHANGES_DIRECTORY.test(text)) {
      moved = true
      return
    }
    const publication = found[index]!
    const place = (path: string, elsewhere: boolean): void => {
      const writer = writes.filter(t => normalise(t.path) === normalise(path) && t.at < start).at(-1)
      if (changedBefore(index, path))
        published.unresolved.push(path)
      else if (writer)
        isLiteralWrite(cmd, scrubbed, all, writer) || published.unresolved.push(path)
      else if (elsewhere && !/^[/~]/.test(path))
        published.unresolved.push(path)
      else
        published.files.push(path)
    }
    for (const script of [...publication.scripts, ...pipedScript(cmd, scrubbed, all, index, publication)]) {
      // The script's own text cannot show what a variable it reads was set to.
      const inner = depth < MAX_SCRIPT_DEPTH ? messageFiles(script, scrubShell(script), depth + 1, hidden.passedBy(segment)) : publishes([], [script.trim()])
      published.unresolved.push(...inner.unresolved)
      inner.files.forEach(path => place(path, moved || publication.elsewhere))
    }
    if (publication.content && hidden.readBy(segment, publication.from))
      published.unresolved.push(text.trim())
    for (const path of publication.files) {
      if (path === '-') {
        const piped = stdinSource(cmd, scrubbed, segment, all)
        published.files.push(...piped.files)
        published.unresolved.push(...piped.unresolved)
        continue
      }
      place(path, moved || publication.elsewhere)
    }
    published.unresolved.push(...publication.unresolved)
  })
  return published
}

interface HiddenContent {
  /** The segment publishes text, from `from` on, from a substitution or a variable that one filled. */
  readonly readBy: (segment: Segment, from: number) => boolean
  /** A script the segment runs may read a variable that one filled. */
  readonly passedBy: (segment: Segment) => boolean
}

// `git commit -m "$(cat .env)"` publishes the substitution's output, and
// `k=$(cat .env); git commit -m "$k"` the variable it fills. What the answers
// rest on is found once, however many segments ask: a long line of `git tag $1;`
// would otherwise rescan everything before each of them. `tainted` carries the
// same suspicion into a script, which cannot see the text it was run from.
// A function body runs when it is called, so on a line that defines one,
// `f "$(cat .env)"` after the body fills its `$1` all the same.
function hiddenContent(cmd: string, scrubbed: string, tainted: boolean): HiddenContent {
  let code: string | undefined
  let expanding: string | undefined
  let firstSubstitution: number | undefined
  let firstRead: number | undefined
  const definesFunction = DEFINES_FUNCTION.test(scrubbed)
  // Comments and heredoc bodies are blanked: an apostrophe in one is no quote.
  const codeOf = (): string => code ??= scrubShell(cmd, 'quotes')
  // Single quotes and escapes too: `'costs $5'` expands nothing.
  const expandingOf = (): string => expanding ??= scrubShell(cmd, 'double')
  // Up to the segment's end, which is where a backquote that closes the command's own substitution stands.
  const substitutes = (segment: Segment, from = segment.start): boolean => opaqueSubstitutionAt(cmd, codeOf(), from, segment.start + segment.text.length) >= 0
  const filledBefore = (offset: number): boolean => {
    if (tainted) {
      return true
    }
    const until = definesFunction ? cmd.length : offset
    firstSubstitution ??= opaqueSubstitutionAt(cmd, codeOf(), 0, cmd.length)
    if (firstSubstitution >= 0 && firstSubstitution < until) {
      return true
    }
    if (firstRead === undefined) {
      const read = READS_INTO_VARIABLE.exec(scrubbed)
      firstRead = read ? read.index + read[0].length : Number.POSITIVE_INFINITY
    }
    return firstRead <= until
  }
  return {
    readBy: (segment, from) => substitutes(segment, from)
      || (EXPANDS_VARIABLE.test(expandingOf().slice(from, segment.start + segment.text.length)) && filledBefore(segment.start)),
    passedBy: segment => substitutes(segment) || filledBefore(segment.start),
  }
}

function isLiteralWrite(cmd: string, scrubbed: string, all: readonly Segment[], target: Target): boolean {
  const writer = all.filter(segment => segment.start <= target.at).at(-1)
  return writer !== undefined && isLiteralStage(cmd, scrubbed, writer, all)
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
  if (cmd.length > MAX_COMMAND_LENGTH) {
    return { findings, redirectTargets: [], messageFiles: [], unresolvedSources: [`a command over ${MAX_COMMAND_LENGTH} characters`] }
  }
  const scrubbed = scrubShell(cmd)
  const published = messageFiles(cmd, scrubbed)
  return {
    findings,
    redirectTargets: writeTargets(cmd, scrubbed).map(t => t.path).filter(path => path !== ''),
    // A command can name one file many times; each caller would read it that often.
    messageFiles: [...new Set(published.files)],
    unresolvedSources: [...new Set(published.unresolved)],
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
  if (typeof cmd !== 'string' || cmd.length > MAX_COMMAND_LENGTH) {
    return false
  }
  const scrubbed = scrubShell(cmd)
  if (!isLoneWrite(cmd, scrubbed)) {
    return false
  }
  const targets = writeTargets(cmd, scrubbed)
  // A caller's policy may cost a process per path, and a command can repeat one.
  const paths = new Set(targets.map(t => t.path))
  return paths.size > 0 && [...paths].every(path => isLiteralPath(path) && accept(path))
}
