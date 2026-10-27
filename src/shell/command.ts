import type { CommandFinding, CommandScan, ScanOptions } from '../types'
import type { Segment } from './parse'
import type { Publication, Script } from './publish'
import { findSecrets } from '../scan/find'
import { ASSIGNMENT_BEFORE, ASSIGNMENT_LOOKBEHIND, CAT_PASSTHROUGH, CHANGES_DIRECTORY, DEFINES_FUNCTION, EXPANDED_INLINE_INPUT, EXPANDS_VARIABLE, FILE_READER, HARMLESS_DEVICE, HARMLESS_REDIRECT, HEREDOC_INTO_CAT, IDENTITY_FROM_READER, INPUT_REDIRECT, LINE_COUNT, LITERAL_STDIN, MAX_COMMAND_LENGTH, MAX_PIPED_STAGES, MAX_SCRIPT_DEPTH, MAX_SEGMENT_TEXT, READING_SUBSTITUTION, READS_INTO_VARIABLE, REDIRECT, REDIRECT_OPERATOR, TEE } from './constants'
import { codeEnd, endOf, hasSubstitution, heredocAt, pairsOf, scrubShell, segments, skipBlanks, unquote, wordAt } from './parse'
import { opaqueSubstitutionAt, printedTexts, publicationOf } from './publish'

interface Target { readonly at: number, readonly path: string }

// A reply from GitHub holds nothing a local file could leak, so redirecting it
// into a message file is not a way to smuggle one in.
const REMOTE_READ = /^\s*gh\s+(?:(?:pr|issue|release|gist|repo|run)\s+(?:view|list|diff|checks)|api)(?=\s|$)/

const ASSIGNMENT_ONLY = /^\s*(?:export\s+)?[A-Z_]\w*=\S*\s*$/i
const INLINE_SCRIPT = /^\s*(?:python3?|node|ruby|perl)\s+(?:-\s+)?<<-?\s*(['"])\w+\1/

// A quoted-heredoc script is text this command carries, and the secret scan
// reads it; what it can do beyond that is open another file, which a string
// that names a path (anything with a slash or an extension besides this
// file's own name) gives away. One that does is not trusted.
function editsOnlyThis(text: string, name: string): boolean {
  if (!INLINE_SCRIPT.test(text))
    return false
  const strings = [...text.matchAll(/(['"])((?:(?!\1)[^\\\n])*)\1/g)].map(m => m[2]!)
  return strings.every(value => value.endsWith(name) || !/[/\\]|^\.|\.\w{1,5}$/.test(value))
}

function isRemoteWrite(all: readonly Segment[], target: Target): boolean {
  const writer = all.filter(segment => segment.start <= target.at && target.at < endOf(segment)).at(-1)
  return writer !== undefined && REMOTE_READ.test(writer.text)
}

const HOME_PREFIX = /^(?:\$HOME|\$\{HOME\})\//
const PLAIN_VARIABLE = /\$(?:\{([A-Z_]\w*)\}|([A-Z_]\w*))/gi

/**
 * A path of plain variables, read from the command's own assignments: the text
 * once each is replaced by the word `before` ends with it set to. A variable
 * set nowhere in the command comes from an environment this cannot see, so the
 * path stays as written, and the caller finds no such file. `null` is a
 * variable that something else than a plain word fills (a substitution, a loop
 * or a function argument), whose path cannot be pinned down. Any other path
 * with a `$` is left as written.
 */
function expandVariables(before: string, path: string): string | null {
  const names = [...path.matchAll(PLAIN_VARIABLE)]
  if (names.length === 0 || /[`~*?[{]/.test(path) || path.replace(PLAIN_VARIABLE, '').includes('$') || HOME_PREFIX.test(path))
    return path
  if (DEFINES_FUNCTION.test(before))
    return null
  let expanded = path
  for (const [whole, braced, bare] of names) {
    const name = (braced ?? bare)!
    const word = new RegExp(`(?:^|[\\s;&|(])(?:export\\s+)?${name}=`, 'g')
    const at = [...before.matchAll(word)].at(-1)
    const rebinds = new RegExp(`\\b(?:for|select|read|mapfile|readarray|declare|typeset|local|unset)\\b[^;&|\\n]*\\b${name}\\b|printf\\s+-v\\s+${name}\\b`).test(before)
    if (rebinds)
      return null
    if (!at)
      return path
    const value = /^(?:"([^"$`\\]*)"|'([^']*)'|([^\s;&|$`"'()\\<>*?[{~]*))(?=$|[\s;&|)])/.exec(before.slice(at.index + at[0].length))
    if (!value)
      return null
    expanded = expanded.replace(whole, (value[1] ?? value[2] ?? value[3])!)
  }
  return expanded
}

/**
 * Every file the command writes through a redirect or `tee`, in order. The
 * operators are found on the scrubbed line, so a `>` or `tee` inside quotes is
 * not one; the operand is read from the original, so a quoted path keeps its
 * spaces. An operand that cannot be read is `''`.
 */
function writeTargets(cmd: string, scrubbed: string, all: readonly Segment[]): Target[] {
  const targets: Target[] = []
  for (const m of scrubbed.matchAll(REDIRECT)) {
    const at = m.index + m[0].length
    targets.push({ at, path: unquote(wordAt(cmd, at)) })
  }
  const { closing } = pairsOf(scrubbed)
  for (const segment of all) {
    const tee = TEE.exec(segment.text)
    if (!tee) {
      continue
    }
    let at = segment.start + tee[0].length
    let options = true
    // A word is read up to here: a backquote that closes the substitution this
    // command is in would otherwise open a span that runs into the next one.
    const end = codeEnd(segment)
    for (;;) {
      at = skipBlanks(cmd, at)
      if (at >= end) {
        break
      }
      const word = wordAt(cmd, at, end)
      if (!word) {
        // `>(cmd)` is a process substitution, not a target: step over it.
        const close = /[<>]/.test(cmd[at]!) && cmd[at + 1] === '(' ? closing.get(at + 1) : undefined
        if (close !== undefined && close < end) {
          at = close + 1
          continue
        }
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
    .map(m => unquote(wordAt(cmd, segment.start + m.index + m[0].length, endOf(segment))))
}

// `--body-file -` reads stdin. A heredoc, a here-string or an echo puts the
// text in the command itself, which is scanned already; a file fed in through
// `<` or `cat file |` is published as surely as one named outright. Any other
// stage piped in (`tee`, `sed`, a subshell) is a source this cannot read.
const textOf = (cmd: string, segment: Segment): string => cmd.slice(segment.start, endOf(segment))

function isPipedFrom(scrubbed: string, segment: Segment, previous: Segment | undefined): previous is Segment {
  return previous !== undefined && /(?<!\|)\|(?!\|)/.test(scrubbed.slice(endOf(previous), segment.start))
}

// Text the shell passes on unexpanded: an `echo` or `printf` with no `$` or
// backtick, a heredoc into `cat` whose delimiter is quoted or whose body has
// neither, or a pass-through stage fed by one of those. Its words are in the
// command, and scanned with it.
function isLiteralStage(cmd: string, scrubbed: string, stage: Segment): boolean {
  let source = stage
  // A loop, not a recursion: a pipe of a hundred thousand `cat`s must not
  // overflow the stack, and a stretch longer than the bound is read as unknown.
  for (let hops = 0; passesStdinThrough(source); hops++) {
    const { before } = source
    if (hops >= MAX_PIPED_STAGES || !isPipedFrom(scrubbed, source, before))
      return false
    source = before
  }
  const original = textOf(cmd, source)
  if (LITERAL_STDIN.test(source.text))
    return !/[$`]/.test(original)
  const heredoc = HEREDOC_INTO_CAT.exec(original)
  if (heredoc === null)
    return false
  const word = heredoc.groups!.word!
  if (unquote(word) !== word)
    return true
  // The body stands after the header line, so a stage piped on from `cat <<EOF`
  // has it in its own text, not here.
  const body = heredocAt(cmd, source.start + heredoc[0].lastIndexOf('<<') + 2)?.body
  return body !== undefined && !/[$`]/.test(original + body)
}

function stdinSource(cmd: string, scrubbed: string, segment: Segment, inherited?: () => Published): Published {
  const { before: previous } = segment
  const redirected = inputRedirects(cmd, segment)
  // `< /dev/null` hands a command no input, as `nc -z host port </dev/null` does.
  if (redirected.length > 0)
    return publishes(redirected.filter(path => !HARMLESS_DEVICE.test(path)))
  if (!isPipedFrom(scrubbed, segment, previous)) {
    const original = textOf(cmd, segment)
    if (EXPANDED_INLINE_INPUT.test(original) && /[$`]/.test(original))
      return publishes([], [original.trim()])
    // A script run by a wrapper reads what the wrapper was given.
    return inherited && !segment.text.includes('<<') ? inherited() : publishes()
  }
  if (isLiteralStage(cmd, scrubbed, previous))
    return publishes()
  const reader = FILE_READER.exec(previous.text)
  const files = reader
    ? [
        ...operands(cmd, previous.start + reader[0].length, endOf(previous)).filter(word => !LINE_COUNT.test(word)),
        ...inputRedirects(cmd, previous),
      ]
    : []
  return files.length > 0 ? publishes(files) : publishes([], [cmd.slice(previous.start, endOf(segment)).trim()])
}

// A stage that hands its stdin on to the next unchanged, so a script printed
// earlier in the pipe reaches the shell as written: a bare `cat`, or a `tee`,
// which also copies it to a file.
function passesStdinThrough(stage: Segment): boolean {
  return CAT_PASSTHROUGH.test(stage.text) || TEE.test(stage.text)
}

interface Piped { scripts: Script[], writer: Segment | undefined, unresolved: string[] }

// `echo 'git add -f .env' | bash` runs the echoed text, and pass-through stages
// between the printer and the shell (`… | cat | bash`, `… | tee x | bash`)
// leave it as written. A stage that rewrites the text (`sed`, `base64 -d`) hides
// the real script, so it is unresolved and blocks; a pipe with no printer at its
// head is a file or a download, beyond what the command line shows.
function pipedScript(cmd: string, scrubbed: string, stage: Segment, publication: Publication): Piped {
  const none: Piped = { scripts: [], writer: undefined, unresolved: [] }
  if (!publication.stdinScript) {
    return none
  }
  let transformed = false
  let consumer = stage
  let hops = 0
  for (let source = stage.before; isPipedFrom(scrubbed, consumer, source); consumer = source, source = source.before) {
    if (++hops > MAX_PIPED_STAGES) {
      return { ...none, unresolved: [cmd.slice(source.start, endOf(stage)).trim()] }
    }
    if (passesStdinThrough(source)) {
      continue
    }
    const texts = printedTexts(cmd, scrubbed, source)
    if (texts.length > 0) {
      return transformed
        ? { ...none, writer: source, unresolved: [cmd.slice(source.start, endOf(stage)).trim()] }
        : { scripts: texts, writer: source, unresolved: [] }
    }
    transformed = true
  }
  return none
}

const normalise = (path: string): string => path.replace(/^(?:\.\/)+/, '')

/**
 * The command's stretches, or `undefined` when nesting makes them too long to
 * read in the time the hook has.
 */
function stretchesOf(scrubbed: string): Segment[] | undefined {
  const all = segments(scrubbed).filter(segment => segment.text.trim() !== '')
  let total = 0
  for (const segment of all) {
    total += segment.text.length
  }
  return total > MAX_SEGMENT_TEXT ? undefined : all
}

/** What a script may hold that its own text does not show. */
interface Taint {
  /** A variable it reads may have been filled from a file by the line that runs it. */
  readonly filled: boolean
  /** The shell that wrote it down expanded text into it, so a `$(…)` or `$k` inside single quotes in it is what that became. */
  readonly expanded: boolean
}

const UNTAINTED: Taint = { filled: false, expanded: false }

/**
 * The files git and gh publish verbatim, `git add -f` stages, and an uploader
 * such as curl, scp or nc sends: .gitignore keeps the first of those out of a
 * commit, so a secret written to .env reaches one through a forced add.
 *
 * A path with `$` or a backtick is kept verbatim, like a redirect target: the
 * caller cannot read it, and silently dropping it would read as "no file".
 * After a `cd`, or under `git -C`, a relative path names a file this cannot
 * place. A file the command writes first is left out when the writer is a
 * literal `echo` or `printf`, whose text is scanned as part of the command;
 * written any other way, its contents are unknown until the command runs.
 * Shell code run through `bash -c`, `eval`, a heredoc or a runner such as
 * `su -c`, `env -S` or `watch` is read the same way.
 *
 * `stdin` is what a script's first reader would get from the wrapper that
 * runs it.
 */
function messageFiles(cmd: string, scrubbed: string, all: readonly Segment[], depth = 0, taint = UNTAINTED, stdin?: () => Published): Published {
  const found = all.map(segment => publicationOf(cmd, scrubbed, segment))
  const writes = writeTargets(cmd, scrubbed, all)
  const published = publishes()
  const hidden = hiddenContent(cmd, scrubbed, taint)
  // `cp .env msg && git commit -F msg`, `dd of=msg` or a script that writes
  // 'msg': a command that mentions the file can change it, so neither the
  // disk's bytes nor an earlier literal write are what gets published. A
  // reader, a `tee` and a literal echo write only through redirects, which are
  // tracked. Built once: a long command line asks about many paths.
  let changers: (string | null)[] | undefined
  const changedBefore = (index: number, path: string): boolean => {
    changers ??= all.map((segment, i) => found[i]!.publishes || FILE_READER.test(segment.text) || TEE.test(segment.text) || isLiteralStage(cmd, scrubbed, segment) || ASSIGNMENT_ONLY.test(segment.text) || REMOTE_READ.test(segment.text) ? null : textOf(cmd, segment))
    const name = normalise(path).split('/').filter(Boolean).at(-1) ?? path
    for (let i = 0; i < index; i++) {
      // A command that holds this one in a substitution has not run yet.
      const text = changers[i]
      if (endOf(all[i]!) <= all[index]!.start && text?.includes(name) && !editsOnlyThis(text, name))
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
    const place = (raw: string, elsewhere: boolean): void => {
      let path = raw
      if (raw.includes('$')) {
        const expanded = expandVariables(cmd.slice(0, start), raw)
        if (expanded === null) {
          published.unresolved.push(raw)
          return
        }
        path = expanded
      }
      const writer = writes.filter(t => normalise(t.path) === normalise(path) && t.at < start).at(-1)
      if (changedBefore(index, path))
        published.unresolved.push(path)
      else if (writer && isRemoteWrite(all, writer))
        published.files.push(path)
      else if (writer)
        isLiteralWrite(cmd, scrubbed, all, writer) || published.unresolved.push(path)
      else if (elsewhere && !/^[/~]/.test(path))
        published.unresolved.push(path)
      else
        published.files.push(path)
    }
    let inherited: Published | undefined
    const stdinOf = (): Published => inherited ??= stdinSource(cmd, scrubbed, segment, stdin)
    const piped = pipedScript(cmd, scrubbed, segment, publication)
    published.unresolved.push(...piped.unresolved)
    // A script piped into a shell is that shell's stdin, so its own commands read nothing from the wrapper.
    const scripts = [
      ...publication.scripts.map(script => ({ script, stdin: stdinOf, writer: segment })),
      ...piped.scripts.map(script => ({ script, stdin: undefined, writer: piped.writer! })),
    ]
    for (const { script, stdin: scriptStdin, writer } of scripts) {
      // The script's own text cannot show what a variable it reads was set to.
      const inner = depth < MAX_SCRIPT_DEPTH ? scriptFiles(script.text, depth + 1, hidden.passedBy(segment, script, writer), scriptStdin) : publishes([], [script.text.trim()])
      published.unresolved.push(...inner.unresolved)
      inner.files.forEach(path => place(path, moved || publication.elsewhere))
    }
    if (publication.content && hidden.readBy(segment, publication))
      published.unresolved.push(text.trim())
    for (const path of publication.files) {
      if (path === '-') {
        const piped = stdinOf()
        // The shell opens a `<` or `cat` operand where the command runs, which
        // `git -C` does not change, but an earlier `cd` and writer do.
        piped.files.forEach(file => place(file, moved))
        published.unresolved.push(...piped.unresolved)
        continue
      }
      place(path, moved || publication.elsewhere)
    }
    published.unresolved.push(...publication.unresolved)
  })
  return published
}

function scriptFiles(script: string, depth: number, taint: Taint, stdin: (() => Published) | undefined): Published {
  const scrubbed = scrubShell(script)
  const all = stretchesOf(scrubbed)
  return all ? messageFiles(script, scrubbed, all, depth, taint, stdin) : publishes([], [script.trim()])
}

interface HiddenContent {
  /** The segment publishes text, from `from` on, from a substitution or a variable that one filled. */
  readonly readBy: (segment: Segment, publication: Pick<Publication, 'from' | 'identity'>) => boolean
  /** What a script the segment runs may hold; `writer` is the stage whose output it is, when not the segment itself. */
  readonly passedBy: (segment: Segment, script: Script, writer?: Segment) => Taint
}

// `git commit -m "$(cat .env)"` publishes the substitution's output, and
// `k=$(cat .env); git commit -m "$k"` the variable it fills. What the answers
// rest on is found once, however many segments ask: a long line of `git tag $1;`
// would otherwise rescan everything before each of them. `taint` carries the
// same suspicion into a script, which cannot see the text it was run from.
// A function body runs when it is called, so on a line that defines one,
// `f "$(cat .env)"` after the body fills its `$1` all the same.
function hiddenContent(cmd: string, scrubbed: string, { filled, expanded }: Taint): HiddenContent {
  let code: string | undefined
  let expanding: string | undefined
  let firstSubstitution: number | undefined
  let firstRead: number | undefined
  let firstReading: number | undefined
  let firstIdentity: number | undefined
  const definesFunction = DEFINES_FUNCTION.test(scrubbed)
  // Comments and heredoc bodies are blanked: an apostrophe in one is no quote.
  // In text that was expanded before it got here, a single quote protects nothing.
  const codeOf = (): string => code ??= expanded ? scrubShell(cmd, 'quotes').replaceAll('\'', ' ') : scrubShell(cmd, 'quotes')
  // Single quotes and escapes too: `'costs $5'` expands nothing.
  const expandingOf = (): string => expanding ??= scrubShell(cmd, expanded ? 'quotes' : 'double')
  // Up to the segment's end, which is where a backquote that closes the command's own substitution stands.
  const substitutes = (segment: Segment, from = segment.start): boolean => opaqueSubstitutionAt(cmd, codeOf(), from, endOf(segment)) >= 0
  const expands = (segment: Segment, from = segment.start): boolean => EXPANDS_VARIABLE.test(expandingOf().slice(from, endOf(segment)))
  const readsBefore = (until: number): boolean => {
    if (firstRead === undefined) {
      const read = READS_INTO_VARIABLE.exec(scrubbed)
      firstRead = read ? read.index + read[0].length : Number.POSITIVE_INFINITY
    }
    return firstRead <= until
  }
  const filledBefore = (offset: number): boolean => {
    if (filled) {
      return true
    }
    const until = definesFunction ? cmd.length : offset
    firstSubstitution ??= opaqueSubstitutionAt(cmd, codeOf(), 0, cmd.length)
    return (firstSubstitution >= 0 && firstSubstitution < until) || readsBefore(until)
  }
  // The author and committer of a commit are published with it, and are set
  // before the subcommand: `git -c user.name=…`, `GIT_AUTHOR_NAME=… git commit`.
  // A substitution there is what they are for (`$(whoami)`), so only one that
  // reads a file counts, or a variable that one or a `read` filled.
  const readerFilledBefore = (offset: number): boolean => {
    if (filled) {
      return true
    }
    firstReading ??= READING_SUBSTITUTION.exec(expandingOf())?.index ?? Number.POSITIVE_INFINITY
    return firstReading < offset || readsBefore(offset)
  }
  const readsIdentity = (segment: Segment, { from, identity }: Pick<Publication, 'from' | 'identity'>): boolean => {
    firstIdentity ??= IDENTITY_FROM_READER.exec(expandingOf())?.index ?? Number.POSITIVE_INFINITY
    // An identity variable set from a file on an earlier part of the line is
    // handed down to the commit, exported or not.
    if (firstIdentity < segment.start) {
      return true
    }
    const head = expandingOf().slice(identity, from)
    return READING_SUBSTITUTION.test(head) || (EXPANDS_VARIABLE.test(head) && readerFilledBefore(segment.start))
  }
  return {
    readBy: (segment, publication) => substitutes(segment, publication.from)
      || (expands(segment, publication.from) && filledBefore(segment.start))
      || readsIdentity(segment, publication),
    passedBy: (segment, script, writer = segment) => ({
      filled: substitutes(segment) || filledBefore(segment.start),
      expanded: script.expanded ?? (substitutes(writer) || expands(writer)),
    }),
  }
}

// The innermost stretch the redirect stands in: `cat .env $(echo x) > msg` is
// the `cat`, not the `echo` that starts later but ends before the `>`.
function isLiteralWrite(cmd: string, scrubbed: string, all: readonly Segment[], target: Target): boolean {
  const writer = all.filter(segment => segment.start <= target.at && target.at < endOf(segment)).at(-1)
  return writer !== undefined && isLiteralStage(cmd, scrubbed, writer)
}

function assignedVariable(cmd: string, start: number): string | undefined {
  const before = cmd.slice(Math.max(0, start - ASSIGNMENT_LOOKBEHIND), start)
  return ASSIGNMENT_BEFORE.exec(before)?.[1]
}

/**
 * Scans a shell command line: the secrets it carries literally, the files it
 * writes, and the files `git` / `gh` would publish from disk or an uploader
 * (`curl`, `scp`, `nc`) would send.
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
  const all = stretchesOf(scrubbed)
  if (!all) {
    return { findings, redirectTargets: [], messageFiles: [], unresolvedSources: ['a command nested too deeply to read'] }
  }
  const published = messageFiles(cmd, scrubbed, all)
  return {
    findings,
    redirectTargets: writeTargets(cmd, scrubbed, all).map(t => t.path).filter(path => path !== ''),
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
  const all = isLoneWrite(cmd, scrubbed) ? stretchesOf(scrubbed) : undefined
  if (!all) {
    return false
  }
  const targets = writeTargets(cmd, scrubbed, all)
  // A caller's policy may cost a process per path, and a command can repeat one.
  const paths = new Set(targets.map(t => t.path))
  return paths.size > 0 && [...paths].every(path => isLiteralPath(path) && accept(path))
}
