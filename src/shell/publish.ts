import type { Heredoc, Segment } from './parse'
import { ANSI_C_STRING, ARGUMENTS_FROM_STDIN, CAT_HEREDOC, CLOSING_PAREN, COMMAND_RUNNERS, CURL_DATA_FILE, CURL_FORM_FILE, CURL_GRAMMAR, CURL_URLENCODE_FILE, ENV_VALUED_OPTION, FIELD_FROM_FILE, GH_ALIASES, GH_FIELD_OPTIONS, GH_GRAMMARS, GH_WRITES, GIT_GRAMMARS, GIT_PLACE_OPTION, GIT_VALUED_GLOBAL, HTTPIE_FILE, HTTPIE_GRAMMAR, IDENTITY_ASSIGNMENT, IDENTITY_CONFIG, LEADING_EXPANSIONS, LITERAL_ECHO, LOGIN_OPTION, MAX_COMMAND_CANDIDATES, NETCATS, REDIRECT_OPERATOR, REMOTE_TARGET, RSYNC_GRAMMAR, RUNNER_COMMAND_OPTION, SCP_GRAMMAR, SHELL_COMMAND_OPTION, SHELL_STDIN_OPTION, SHELL_VALUED_LONG_OPTION, SHELLS, SPLIT_STRING_OPTION, UPLOADERS, WATCH_VALUED_OPTION, WGET_GRAMMAR } from './constants'
import { afterContinuations, codeEnd, decodeEscapes, endOf, heredocAt, pairsOf, skipBlanks, unquote, wordAt } from './parse'

type LongOption = readonly [name: string, shortestPrefix: number, valued: boolean]

/** How a subcommand's arguments read: see GIT_GRAMMARS. */
export interface Grammar {
  /** Short options that take a value, glued (`-Fmsg`) or as the next word. */
  readonly short: string
  readonly long: readonly LongOption[]
  readonly files: readonly string[]
}

/** Shell code that a command hands to a shell of its own. */
export interface Script {
  readonly text: string
  /**
   * The shell that wrote it down has filled in what it holds: a `$(…)` or a
   * `$k` inside single quotes in it stands for what that became. Known for a
   * heredoc, which its delimiter settles; a word is left to the text around it.
   */
  readonly expanded?: boolean
}

/** What one segment of a command line publishes. */
export interface Publication {
  /** It runs git or gh to publish, so it is not a writer of the files it names. */
  readonly publishes: boolean
  /** Its content comes from what it names or substitutes, not only from files. */
  readonly content: boolean
  /** Files it publishes; `-` is its stdin. */
  readonly files: string[]
  readonly unresolved: string[]
  /** Command text it runs in a shell of its own (`bash -c`, `eval`, `su -c`, a heredoc). */
  readonly scripts: Script[]
  /** It runs git, or its scripts, in another directory, where a relative path means something else. */
  readonly elsewhere: boolean
  /** It is a shell that reads its script from stdin. */
  readonly stdinScript: boolean
  /** Where its arguments start, after the subcommand: a substitution before it, as in `git -C $(pwd)`, adds no content. */
  readonly from: number
  /**
   * Where the author or committer of a commit it makes is set before the
   * subcommand (`git -c user.name=…`, `GIT_AUTHOR_NAME=…`): a substitution
   * there adds content once it reads a file. Infinity when none is.
   */
  readonly identity: number
}

interface Word { readonly value: string, readonly at: number, readonly end: number }

interface Option { readonly name: string, readonly value: string | undefined, readonly valued: boolean, readonly at: number }

interface Parsed { readonly options: Option[], readonly operands: string[] }

/** A segment's words, the offset after each `<<`, and the text of each here-string. */
interface Spoken { readonly words: Word[], readonly heredocs: number[], readonly hereStrings: string[] }

const COMMANDS = new Set(['git', 'gh', 'eval', ...SHELLS])

const NOTHING: Publication = Object.freeze({ publishes: false, content: false, files: [], unresolved: [], scripts: [], elsewhere: false, stdinScript: false, from: 0, identity: Number.POSITIVE_INFINITY })

// A publication whose files cannot be named: the caller blocks the call
// rather than pass what it cannot see.
const unreadable = (text: string, content = false): Publication => ({ ...NOTHING, publishes: true, content, unresolved: [text] })

// The command a word names, past the expansions glued before it: `${X}git`
// runs git when X is empty.
function nameOf(cmd: string, word: Word): string {
  const raw = cmd.slice(word.at, word.end)
  const name = unquote(raw.slice(LEADING_EXPANSIONS.exec(raw)?.[0].length ?? 0))
  return name.slice(name.lastIndexOf('/') + 1)
}

const isFilledIn = (word: string): boolean => /[$`]/.test(word)

// A brace pattern this wide is read as a glob that could name git or gh, since
// a command name does not spread over so many alternatives.
const MAX_BRACE_WORDS = 64

// Reads the command word as a glob pattern, keeping its quoting: a backslash
// escapes the quoted characters so a `*` inside quotes stays a literal filename
// character rather than a wildcard.
function globPattern(raw: string): string {
  let out = ''
  const literal = (text: string): void => {
    for (const c of text) {
      out += /[*?[\]{},\\]/.test(c) ? `\\${c}` : c
    }
  }
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!
    if (c === '\\') {
      if (i + 1 < raw.length) {
        literal(raw[++i]!)
      }
    }
    else if (c === '\'') {
      const end = raw.indexOf('\'', i + 1)
      literal(raw.slice(i + 1, end < 0 ? undefined : end))
      i = end < 0 ? raw.length : end
    }
    else if (c === '$' && raw[i + 1] === '\'') {
      ANSI_C_STRING.lastIndex = i
      const ansi = ANSI_C_STRING.exec(raw)
      literal(ansi ? unquote(ansi[0]) : raw.slice(i))
      i = ansi ? ANSI_C_STRING.lastIndex - 1 : raw.length
    }
    else if (c === '"') {
      let end = i + 1
      while (end < raw.length && raw[end] !== '"') {
        end += raw[end] === '\\' ? 2 : 1
      }
      literal(raw.slice(i + 1, end).replace(/\\(["\\$`])/g, '$1'))
      i = end
    }
    else {
      out += c
    }
  }
  return out
}

// The brace-free alternatives a pattern expands to, or `null` when it would
// spread past the bound: too many words, or nested deeper than that many could
// reach. Only the first group on a path is split; the rest follow the recursion.
function expandBraces(pattern: string): string[] | null {
  const out: string[] = []
  // A `{` that opens no group is scanned to the line's end, so a run of them is
  // bounded too, not only the words and the nesting the recursion reaches.
  let probes = 0
  const expand = (prefix: string, rest: string, depth: number): boolean => {
    if (out.length > MAX_BRACE_WORDS || depth > MAX_BRACE_WORDS || probes > MAX_BRACE_WORDS) {
      return false
    }
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '\\') {
        i++
        continue
      }
      if (rest[i] === '{') {
        probes++
        const alternatives = braceAlternatives(rest, i)
        if (alternatives) {
          return alternatives.every(alt => expand(prefix + rest.slice(0, i), alt + rest.slice(alternatives.end), depth + 1))
        }
        if (probes > MAX_BRACE_WORDS) {
          return false
        }
      }
    }
    out.push(prefix + rest)
    return true
  }
  return expand('', pattern, 0) ? out : null
}

interface BraceAlternatives extends Array<string> { end: number }

// The comma-separated alternatives of the brace group that opens at `open`, and
// where it closes, or `null` when it is not a group (no comma, or unbalanced).
function braceAlternatives(pattern: string, open: number): BraceAlternatives | null {
  const parts: string[] = []
  let depth = 0
  let start = open + 1
  for (let i = open; i < pattern.length; i++) {
    const c = pattern[i]!
    if (c === '\\') {
      i++
    }
    else if (c === '{') {
      depth++
    }
    else if (c === ',' && depth === 1) {
      parts.push(pattern.slice(start, i))
      start = i + 1
    }
    else if (c === '}' && --depth === 0) {
      if (parts.length === 0) {
        return null
      }
      parts.push(pattern.slice(start, i))
      return Object.assign(parts, { end: i + 1 })
    }
  }
  return null
}

// Whether the brace-free glob `pattern` matches the whole of `text`, with `*`,
// `?`, `[…]` classes and backslash escapes. `text` is only ever `git` or `gh`.
function globMatches(pattern: string, text: string): boolean {
  let p = 0
  let t = 0
  let star = -1
  let mark = 0
  while (t < text.length) {
    const c = pattern[p]
    if (c === '\\' && p + 1 < pattern.length && pattern[p + 1] === text[t]) {
      p += 2
      t++
    }
    else if (c === '?') {
      p++
      t++
    }
    else if (c === '*') {
      star = p++
      mark = t
    }
    else if (c === '[') {
      const next = matchClass(pattern, p, text[t]!)
      if (next < 0) {
        if (star < 0) {
          return false
        }
        p = star + 1
        t = ++mark
      }
      else {
        p = next
        t++
      }
    }
    else if (c !== undefined && c !== '\\' && c !== '*' && c !== '?' && c !== '[' && c === text[t]) {
      p++
      t++
    }
    else if (star >= 0) {
      p = star + 1
      t = ++mark
    }
    else {
      return false
    }
  }
  while (pattern[p] === '*') {
    p++
  }
  return p === pattern.length
}

// Reads the `[…]` class at `open` against `char`; returns the offset after the
// `]` on a match, or -1. Supports `!`/`^` negation and `a-z` ranges.
function matchClass(pattern: string, open: number, char: string): number {
  let i = open + 1
  const negated = pattern[i] === '!' || pattern[i] === '^'
  if (negated) {
    i++
  }
  let matched = false
  for (let first = true; i < pattern.length && (first || pattern[i] !== ']'); first = false) {
    if (pattern[i + 1] === '-' && pattern[i + 2] !== undefined && pattern[i + 2] !== ']') {
      matched ||= char >= pattern[i]! && char <= pattern[i + 2]!
      i += 3
    }
    else {
      matched ||= char === pattern[i]
      i++
    }
  }
  return pattern[i] === ']' && matched !== negated ? i + 1 : -1
}

// Whether the command word, read unquoted as a glob with brace expansion, could
// name git or gh. Scrubbing blanks quoted parts, so a `* ? [ {` still standing
// in `scrubbed` was unquoted and is a wildcard; the pattern is read from `cmd`,
// where the quoting tells a wildcard from a literal filename character. git and
// gh are the only names that would publish, so only they are tested.
function isGlobName(cmd: string, scrubbed: string, word: Word): boolean {
  if (!/[*?[{]/.test(scrubbed.slice(word.at, word.end))) {
    return false
  }
  const raw = cmd.slice(word.at, word.end)
  const pattern = globPattern(raw.slice(LEADING_EXPANSIONS.exec(raw)?.[0].length ?? 0))
  const base = pattern.slice(pattern.lastIndexOf('/') + 1)
  const alternatives = expandBraces(base)
  if (alternatives === null) {
    return true
  }
  return alternatives.some(alt => globMatches(alt, 'git') || globMatches(alt, 'gh'))
}

const GH_GROUPS = new Set(Object.keys(GH_GRAMMARS).map(key => key.split(' ')[0]!))

// The word at `at`, with a substitution the word pattern cannot read, one
// nested deeper than it counts or a process substitution, taken through the
// parenthesis that closes it. Dropping the rest of the segment there would hide
// the command that stands after `FOO=$(…) `.
function wordFrom(cmd: string, at: number, end: number, closing: ReadonlyMap<number, number>): string {
  let word = wordAt(cmd, at, end)
  for (;;) {
    const next = at + word.length
    const open = cmd[next] === '(' && word.endsWith('$') ? next : /[<>]/.test(cmd[next] ?? '') && cmd[next + 1] === '(' ? next + 1 : -1
    const close = open < 0 ? undefined : closing.get(open)
    if (close === undefined || close >= end) {
      return word
    }
    word += cmd.slice(next, close + 1) + wordAt(cmd, close + 1, end)
  }
}

/** The segment's words as the shell passes them, unquoted, with redirects and their targets left out. */
function wordsOf(cmd: string, segment: Segment, closing: ReadonlyMap<number, number>): Spoken {
  const end = codeEnd(segment)
  const words: Word[] = []
  const heredocs: number[] = []
  const hereStrings: string[] = []
  let at = skipBlanks(cmd, segment.start)
  while (at < end) {
    const raw = wordFrom(cmd, at, end, closing)
    if (raw && !(/^\d+$/.test(raw) && /[<>]/.test(cmd[at + raw.length] ?? ''))) {
      words.push({ value: unquote(raw), at, end: at + raw.length })
      at = skipBlanks(cmd, at + raw.length)
      continue
    }
    at += raw.length
    REDIRECT_OPERATOR.lastIndex = at
    const operator = REDIRECT_OPERATOR.exec(cmd)
    if (!operator)
      break
    at += operator[0].length
    if (operator[0] === '<<')
      heredocs.push(at)
    at = skipBlanks(cmd, at)
    const target = wordFrom(cmd, at, end, closing)
    if (operator[0] === '<<<')
      hereStrings.push(unquote(target))
    at = skipBlanks(cmd, at + target.length)
  }
  return { words, heredocs, hereStrings }
}

function parse(words: readonly Word[], grammar: Grammar): Parsed {
  const options: Option[] = []
  const operands: string[] = []
  let parsingOptions = true
  for (let k = 0; k < words.length; k++) {
    const { value: word, at } = words[k]!
    if (!parsingOptions || word === '-' || !word.startsWith('-')) {
      operands.push(word)
    }
    else if (word === '--') {
      parsingOptions = false
    }
    else if (word.startsWith('--')) {
      const eq = word.indexOf('=')
      const given = word.slice(2, eq < 0 ? undefined : eq)
      const long = grammar.long.find(([name, shortest]) => name === given || (shortest > 0 && given.length >= shortest && name.startsWith(given)))
      if (long) {
        const [name, , valued] = long
        options.push({ name, valued, at, value: eq >= 0 ? word.slice(eq + 1) : valued ? words[++k]?.value : undefined })
      }
    }
    else {
      for (let l = 1; l < word.length; l++) {
        const name = word[l]!
        if (grammar.short.includes(name)) {
          options.push({ name, valued: true, at, value: l + 1 < word.length ? word.slice(l + 1) : words[++k]?.value })
          break
        }
        options.push({ name, valued: false, at, value: undefined })
      }
    }
  }
  return { options, operands }
}

const has = (parsed: Parsed, ...names: string[]): boolean => parsed.options.some(o => names.includes(o.name))

// A file option left without a value, or with an empty one (`-F <(…)` leaves
// none, the substitution being no word), is a source that cannot be pinned down.
function addFile(path: string | undefined, publication: Publication, text: string): void {
  if (path)
    publication.files.push(path)
  else
    publication.unresolved.push(text)
}

function optionFiles(parsed: Parsed, grammar: Grammar, publication: Publication, text: string): void {
  for (const option of parsed.options.filter(o => o.valued && grammar.files.includes(o.name)))
    addFile(option.value, publication, text)
}

// `guessed` is set when the command name was filled in by the shell and only
// may be git: a subcommand filled in as well then proves nothing.
function git(words: readonly Word[], fromStdin: boolean, text: string, guessed = false): Publication {
  let j = 0
  let elsewhere = false
  let identity = Number.POSITIVE_INFINITY
  while (j < words.length && words[j]!.value.startsWith('-')) {
    const option = words[j]!.value
    // An alias defined on the command line can stand for any subcommand.
    if (option === '-c' && /^alias\./i.test(words[j + 1]?.value ?? ''))
      return unreadable(text)
    if (option === '-c' && IDENTITY_CONFIG.test(words[j + 1]?.value ?? ''))
      identity = Math.min(identity, words[j]!.at)
    elsewhere ||= GIT_PLACE_OPTION.test(option)
    j += GIT_VALUED_GLOBAL.test(option) ? 2 : 1
  }
  const sub = words[j]?.value === 'stage' ? 'add' : words[j]?.value ?? ''
  // `git $(echo add)` can run any subcommand.
  if (isFilledIn(sub))
    return guessed ? NOTHING : unreadable(text)
  if (sub === 'fast-import')
    return unreadable(text)
  // `constructor` and the like are no subcommands, and no grammar either.
  const grammar = Object.hasOwn(GIT_GRAMMARS, sub) ? GIT_GRAMMARS[sub] : undefined
  if (!grammar)
    return NOTHING
  const parsed = parse(words.slice(j + 1), grammar)
  const publication: Publication = { ...NOTHING, publishes: true, content: true, elsewhere, from: words[j]!.end, identity, files: [], unresolved: [] }
  if (sub === 'add' || sub === 'update-index' || sub === 'hash-object') {
    const stages = sub === 'add' ? has(parsed, 'f', 'force') : sub === 'update-index' ? has(parsed, 'add', 'index-info') : has(parsed, 'w')
    if (!stages)
      return { ...publication, content: false }
    // The paths arrive from stdin or a file this cannot see.
    if (fromStdin || has(parsed, 'pathspec-from-file', 'stdin', 'stdin-paths', 'index-info'))
      return { ...publication, unresolved: [text] }
    const all = sub === 'add' && parsed.operands.length === 0 && has(parsed, 'A', 'all')
    publication.files.push(...(all ? ['.'] : parsed.operands))
    return publication
  }
  // A stash publishes only through its message: `git stash [push] -m <msg>` or
  // `git stash save <msg>`, like a commit message. Listing or popping does not.
  if (sub === 'stash') {
    const saves = parsed.operands[0] === 'save' && parsed.operands.length > 1
    return has(parsed, 'm', 'message') || saves ? publication : NOTHING
  }
  if (fromStdin)
    return { ...publication, unresolved: [text] }
  optionFiles(parsed, grammar, publication, text)
  return publication
}

// gh finds its subcommand past any flag, taking the word after a `-x` or a
// `--name` as that flag's value, and the subcommand then reads every flag on
// the line: `gh -R o/r pr create -F body` and `gh pr -R o/r create` both run
// `pr create`.
function ghCommandPath(words: readonly Word[]): number[] {
  const path: number[] = []
  for (let k = 0; k < words.length && path.length < 2; k++) {
    const word = words[k]!.value
    if (word === '--')
      break
    if (!word.startsWith('-'))
      path.push(k)
    else if (/^-[^-]$|^--[^=]+$/.test(word))
      k++
  }
  return path
}

// Where the first flag stands before the last word of the subcommand, or
// Infinity. gh takes its flags on either side of that word, so the content of
// `gh pr -b "$(cat .env)" create` and `gh api -f body=… repos/o/r` stands ahead
// of it; only the repository (`-R o/r`, `--repo=o/r`) is no content.
function flagBefore(words: readonly Word[], path: readonly number[]): number {
  for (let k = 0; k < path.at(-1)!; k++) {
    const word = words[k]!.value
    if (path.includes(k))
      continue
    if (word === '-R' || word === '--repo')
      k++
    else if (!/^-R|^--repo=/.test(word))
      return words[k]!.at
  }
  return Number.POSITIVE_INFINITY
}

function gh(words: readonly Word[], fromStdin: boolean, text: string, guessed = false): Publication {
  const path = ghCommandPath(words)
  const [group = '', rawSub = ''] = path.map(k => words[k]!.value)
  // `gh api`'s second word is the endpoint, which no alias renames.
  const sub = group === 'api' ? rawSub : GH_ALIASES.get(rawSub) ?? rawSub
  const key = group === 'pr' || group === 'issue' || group === 'api' ? group : `${group} ${sub}`
  if (isFilledIn(group) || (GH_GROUPS.has(group) && key !== 'api' && isFilledIn(sub))) {
    return guessed ? NOTHING : unreadable(text)
  }
  const grammar = GH_GRAMMARS[`${group} ${sub}`] ?? GH_GRAMMARS[key]
  if (!grammar || ((key === 'pr' || key === 'issue') && !GH_WRITES.has(sub)))
    return NOTHING
  if (fromStdin)
    return unreadable(text, true)
  const named = key === group ? path.slice(0, 1) : path
  const parsed = parse(words.filter((_, k) => !named.includes(k)), grammar)
  // `gh api` without a field or an input only reads, and `gh workflow run`
  // without one sends only the ref.
  const fielded = key === 'api' || key === 'workflow run'
  const content = !fielded || has(parsed, ...GH_FIELD_OPTIONS)
  const publication: Publication = { ...NOTHING, publishes: true, content, from: Math.min(words[path.at(-1)!]!.end, flagBefore(words, path)), files: [], unresolved: [] }
  optionFiles(parsed, grammar, publication, text)
  // A release asset may carry a display label after `#`.
  const assets = parsed.operands.slice(key === 'pr' || key === 'issue' ? parsed.operands.length : 1).map(path => path.replace(/#[^/]*$/, ''))
  if (key === 'release create' || key === 'release upload' || key === 'gist edit')
    assets.forEach(path => addFile(path, publication, text))
  // With no file named, `gh gist create` publishes its stdin.
  if (key === 'gist create')
    (parsed.operands.length > 0 ? parsed.operands : ['-']).forEach(path => addFile(path, publication, text))
  // Without a body or an env file, `gh variable set` stores its stdin, and
  // `gh workflow run --json` reads its inputs from stdin.
  if ((key === 'variable set' && !has(parsed, 'b', 'body', 'f', 'env-file')) || (key === 'workflow run' && has(parsed, 'json'))) {
    addFile('-', publication, text)
  }
  if (fielded) {
    for (const option of parsed.options.filter(o => o.name === 'F' || o.name === 'field')) {
      const file = FIELD_FROM_FILE.exec(option.value ?? '')
      if (file)
        addFile(file[1], publication, text)
    }
  }
  return publication
}

// The files curl sends: a request body, a form field or an upload, each from a
// file the option's value points at. `@-` and `-T -` send stdin.
function curlFiles(words: readonly Word[], publication: Publication, text: string): void {
  for (const option of parse(words, CURL_GRAMMAR).options) {
    const value = option.value ?? ''
    const file
      = option.name === 'data' || option.name === 'data-ascii' || option.name === 'data-binary' || option.name === 'd'
        ? CURL_DATA_FILE.exec(value)?.[1]
        : option.name === 'data-urlencode'
          ? CURL_URLENCODE_FILE.exec(value)?.[1]
          : option.name === 'form' || option.name === 'F'
            ? CURL_FORM_FILE.exec(value)?.[1]
            : option.name === 'upload-file' || option.name === 'T'
              ? value
              : undefined
    if (file !== undefined)
      addFile(file, publication, text)
  }
}

// The local files a copy to a remote host sends: with a remote destination
// last, every source that is not itself remote. A copy between local paths, or
// one that only pulls down, sends nothing.
function remoteFiles(words: readonly Word[], grammar: Grammar, publication: Publication, text: string): void {
  const { operands } = parse(words, grammar)
  if (operands.length < 2 || !REMOTE_TARGET.test(operands.at(-1)!))
    return
  for (const source of operands.slice(0, -1).filter(path => !REMOTE_TARGET.test(path)))
    addFile(source, publication, text)
}

// A command that reads a file and sends it off the machine. Each file is
// published as a message file is, so its contents are scanned and an ignored
// one holding a secret still blocks; netcat sends its stdin, read as `-`.
function uploaded(name: string, words: readonly Word[], text: string): Publication {
  const publication: Publication = { ...NOTHING, publishes: true, files: [], unresolved: [] }
  if (name === 'curl') {
    curlFiles(words, publication, text)
  }
  else if (name === 'wget') {
    const parsed = parse(words, WGET_GRAMMAR)
    optionFiles(parsed, WGET_GRAMMAR, publication, text)
  }
  else if (name === 'http' || name === 'https' || name === 'httpie') {
    for (const operand of parse(words, HTTPIE_GRAMMAR).operands) {
      const file = HTTPIE_FILE.exec(operand)
      if (file)
        addFile(file[1], publication, text)
    }
  }
  else if (name === 'scp') {
    remoteFiles(words, SCP_GRAMMAR, publication, text)
  }
  else if (name === 'rsync') {
    remoteFiles(words, RSYNC_GRAMMAR, publication, text)
  }
  else if (NETCATS.has(name)) {
    addFile('-', publication, text)
  }
  return publication.files.length > 0 || publication.unresolved.length > 0 ? publication : NOTHING
}

// The shell that sets up a bare heredoc drops a backslash before `$`, a backquote
// or another backslash, and joins a line that ends in one to the next.
const HEREDOC_ESCAPE = /\\([$`\\])|\\\n/g

/** What a command reads from its here-strings and heredocs. */
function heredocTexts(cmd: string, { heredocs, hereStrings }: Spoken): Script[] {
  return [
    ...hereStrings.map(text => ({ text })),
    ...heredocs.map(at => heredocAt(cmd, at)).filter((doc): doc is Heredoc => doc !== null).map(doc => ({
      text: doc.quoted ? doc.body : doc.body.replace(HEREDOC_ESCAPE, '$1'),
      expanded: !doc.quoted,
    })),
  ]
}

/**
 * What a shell is given besides its options: `-c` takes the first word left as
 * its script, and without `-c` that word is a script file. A word with a value
 * of its own (`-o pipefail`, `-eo pipefail`, `--rcfile f`) takes the next word
 * with it, `+x` is an option as `-x` is, and `--` or `-` ends them.
 */
function shellArguments(rest: readonly Word[]): { operands: readonly Word[], command: boolean, stdin: boolean } {
  let command = false
  let stdin = false
  let k = 0
  for (; k < rest.length; k++) {
    const word = rest[k]!.value
    if (word === '--' || word === '-') {
      k++
      break
    }
    if (!/^[-+]./.test(word)) {
      break
    }
    command ||= SHELL_COMMAND_OPTION.test(word)
    stdin ||= SHELL_STDIN_OPTION.test(word)
    k += word.startsWith('--') ? Number(SHELL_VALUED_LONG_OPTION.test(word)) : (word.match(/o/gi)?.length ?? 0)
  }
  return { operands: rest.slice(k), command, stdin }
}

/**
 * The shell code a segment hands to a shell of its own: `bash -c '…'`,
 * `eval …`, or a heredoc fed to a shell. A script read from a file is beyond
 * what a command line shows; one piped in is the caller's to find, since it
 * sees the stage before.
 */
function scriptsOf(cmd: string, spoken: Spoken, command: number): Script[] {
  const name = nameOf(cmd, spoken.words[command]!)
  const rest = spoken.words.slice(command + 1)
  if (name === 'eval')
    return [{ text: rest.map(w => w.value).join(' ') }]
  const { operands, command: runsString } = shellArguments(rest)
  if (runsString)
    return operands.length > 0 ? [{ text: operands[0]!.value }] : []
  return heredocTexts(cmd, spoken)
}

const PRINTERS = new Set(['echo', 'printf', 'cat'])

// printf reuses its format until the arguments run out. Each directive takes
// an argument, whatever it converts; `%%` takes none.
function printfOutput(format: string, args: readonly string[]): string {
  let out = ''
  let next = 0
  do {
    const before = next
    out += format.replace(/%(?:%|[-+ #0]*(?:[1-9]\d*)?(?:\.\d+)?[a-z])/gi, directive => directive === '%%' ? '%' : args[next++] ?? '')
    if (next === before)
      break
  } while (next < args.length)
  return decodeEscapes(out)
}

/**
 * The texts an `echo`, `printf` or `cat <<EOF` stage prints, or none for any
 * other stage: what a shell it is piped into would run. The `$` and backticks
 * are kept, so a substitution the shell would fill in still shows as one. The
 * command is found by its unquoted name, as in `publicationOf`. Whether an
 * `echo` turns `\x67` into a character depends on the shell and its flags, so
 * it gives the text as written and as decoded.
 */
export function printedTexts(cmd: string, scrubbed: string, stage: Segment): Script[] {
  const spoken = wordsOf(cmd, stage, pairsOf(scrubbed).closing)
  const { words } = spoken
  const printer = words.findIndex(w => PRINTERS.has(nameOf(cmd, w)))
  if (printer < 0) {
    return []
  }
  const name = nameOf(cmd, words[printer]!)
  if (name === 'cat') {
    return heredocTexts(cmd, spoken)
  }
  const args = words.slice(printer + 1).map(w => w.value)
  if (name === 'printf') {
    const [format = '', ...rest] = args[0] === '--' ? args.slice(1) : args
    return [{ text: printfOutput(format, rest) }]
  }
  const first = args.findIndex(arg => !/^-[neE]+$/.test(arg))
  const written = first < 0 ? '' : args.slice(first).join(' ')
  return [...new Set([written, decodeEscapes(written)])].map(text => ({ text }))
}

// `env -S` splits its string into the command and appends the words after
// it. env stops reading options at its first operand, which is already the
// command or an assignment, so a `-S` past it belongs to the command.
function splitString(rest: readonly Word[]): string | undefined {
  for (let k = 0; k < rest.length; k++) {
    const word = rest[k]!.value
    const option = SPLIT_STRING_OPTION.exec(word)
    if (option) {
      const glued = word.slice(option[0].length)
      const inline = glued !== '' || option[0].endsWith('=')
      const value = inline ? glued : rest[k + 1]?.value
      return value === undefined ? undefined : [value, ...rest.slice(inline ? k + 1 : k + 2).map(w => w.value)].join(' ')
    }
    if (word === '--' || !word.startsWith('-')) {
      return undefined
    }
    if (ENV_VALUED_OPTION.test(word)) {
      k++
    }
  }
  return undefined
}

// watch joins its operands and runs them through `sh -c`.
function watched(rest: readonly Word[]): string | undefined {
  let k = 0
  for (; k < rest.length && rest[k]!.value.startsWith('-'); k++) {
    if (rest[k]!.value === '--') {
      k++
      break
    }
    if (WATCH_VALUED_OPTION.test(rest[k]!.value)) {
      k++
    }
  }
  return k < rest.length ? rest.slice(k).map(w => w.value).join(' ') : undefined
}

/** The command string a runner such as `su -c` or `env -S` is given, if any. */
function runnerScript(name: string, rest: readonly Word[]): string | undefined {
  if (name === 'env') {
    return splitString(rest)
  }
  if (name === 'watch') {
    return watched(rest)
  }
  const flag = rest.findIndex(w => SHELL_COMMAND_OPTION.test(w.value) || RUNNER_COMMAND_OPTION.test(w.value))
  if (flag < 0) {
    return undefined
  }
  const word = rest[flag]!.value
  return word.startsWith('--') && word.includes('=') ? word.slice(word.indexOf('=') + 1) : rest[flag + 1]?.value
}

function backticksBefore(scrubbed: string, at: number): number {
  const { ticks } = pairsOf(scrubbed)
  let low = 0
  let high = ticks.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (ticks[mid]! < at) {
      low = mid + 1
    }
    else {
      high = mid
    }
  }
  return low
}

const opensBacktick = (scrubbed: string, at: number): boolean => scrubbed[at] === '`' && backticksBefore(scrubbed, at) % 2 === 0

function closesSubstitution(scrubbed: string, at: number): boolean {
  return scrubbed[at] === ')' || (scrubbed[at] === '`' && backticksBefore(scrubbed, at) % 2 === 1)
}

// `$g`, `"$GIT"` or `$(which git)`: a name the shell fills in may be git or gh.
const isFilledInName = (word: Word): boolean => isFilledIn(word.value.slice(word.value.lastIndexOf('/') + 1))

const isCandidate = (name: string, word: Word): boolean => COMMANDS.has(name) || COMMAND_RUNNERS.has(name) || UPLOADERS.has(name) || isFilledInName(word)

function tryCommand(cmd: string, spoken: Spoken, command: number, fromStdin: boolean, text: string): Publication {
  const { words, heredocs, hereStrings } = spoken
  const name = nameOf(cmd, words[command]!)
  const rest = words.slice(command + 1)
  if (COMMAND_RUNNERS.has(name)) {
    const script = runnerScript(name, rest)
    const login = (name === 'su' || name === 'runuser') && rest.some(w => LOGIN_OPTION.test(w.value))
    return script === undefined ? NOTHING : { ...NOTHING, scripts: [{ text: script }], elsewhere: login }
  }
  if (name === 'git') {
    return git(rest, fromStdin, text)
  }
  if (name === 'gh') {
    return gh(rest, fromStdin, text)
  }
  if (UPLOADERS.has(name)) {
    return uploaded(name, rest, text)
  }
  if (!COMMANDS.has(name)) {
    // `$g add -f .env` may run git or gh with the words that follow.
    return [git(rest, fromStdin, text, true), gh(rest, fromStdin, text, true)].find(p => p.publishes) ?? NOTHING
  }
  // Without `-c` a shell reads its script from stdin only when it has no script file, or is given `-s`.
  const { operands, command: runsString, stdin } = shellArguments(rest)
  const stdinScript = name !== 'eval' && heredocs.length === 0 && hereStrings.length === 0 && !runsString && (stdin || operands.length === 0)
  return { ...NOTHING, scripts: scriptsOf(cmd, spoken, command), stdinScript }
}

/**
 * What a segment publishes through git or gh. The command is found by name
 * wherever it stands, unquoted (`'git'`, `\git`, `/usr/bin/git`), so a wrapper
 * this does not know (`nice`, `timeout 5`, `find -exec`) cannot hide it, at
 * worst it reads a file that is not one. A name the shell fills in (`$g`,
 * `$(which git)`) is read as git or gh, whichever its arguments would make
 * publish, and a git or gh subcommand the shell fills in is unknown.
 * Arguments built from stdin by `xargs` or `parallel` cannot be read.
 */
export function publicationOf(cmd: string, scrubbed: string, segment: Segment): Publication {
  const spoken = wordsOf(cmd, segment, pairsOf(scrubbed).closing)
  const { words } = spoken
  const text = segment.text.trim()
  const end = endOf(segment)
  // Segments are joined over a substitution, so this only fires where that
  // join could not pair the parentheses (a `case` pattern inside `$(…)`): the
  // shell still glues the substitution's output to the words around it.
  if (closesSubstitution(scrubbed, segment.start - 1)) {
    words.unshift({ value: '$', at: segment.start, end: segment.start })
  }
  if (opensBacktick(scrubbed, end)) {
    words.push({ value: '`', at: end, end })
  }
  // A word that only looks like the command (`A=/git git commit`, `sudo -u git
  // git add`) can stand before it, so each one is tried in turn, up to a bound.
  let fromStdin = false
  let tried = 0
  let command = 0
  for (; command < words.length && tried < MAX_COMMAND_CANDIDATES; command++) {
    const name = nameOf(cmd, words[command]!)
    fromStdin ||= ARGUMENTS_FROM_STDIN.has(name)
    if (!isCandidate(name, words[command]!) && !isGlobName(cmd, scrubbed, words[command]!)) {
      continue
    }
    tried++
    const publication = tryCommand(cmd, spoken, command, fromStdin, text)
    if (publication.publishes || publication.scripts.length > 0 || publication.stdinScript) {
      const assigned = words.slice(0, command).find(w => IDENTITY_ASSIGNMENT.test(w.value))
      return assigned && publication.content ? { ...publication, identity: Math.min(publication.identity, assigned.at) } : publication
    }
  }
  // A command the bound kept this from trying is unknown, not harmless: a word
  // before it may be an assignment, or an unquoted expansion that is empty and
  // vanishes, as in `$a $b … git add -f .env`. A quoted one never vanishes.
  const untried = (word: Word): boolean => {
    const name = nameOf(cmd, word)
    return COMMANDS.has(name) || COMMAND_RUNNERS.has(name) || UPLOADERS.has(name) || isGlobName(cmd, scrubbed, word) || (isFilledInName(word) && !/["']/.test(cmd.slice(word.at, word.end)))
  }
  if (words.slice(command).some(untried)) {
    return unreadable(text)
  }
  return NOTHING
}

// The offset after a `$(…)` whose output is text the command already shows,
// a quoted heredoc or a plain echo, or -1 when its output is unknown.
function literalSubstitutionEnd(cmd: string, at: number): number {
  CAT_HEREDOC.lastIndex = at
  if (CAT_HEREDOC.test(cmd)) {
    const doc = heredocAt(cmd, CAT_HEREDOC.lastIndex)
    if (!doc || doc.rest.trim() !== '' || (!doc.quoted && /\$\(|`/.test(doc.body)))
      return -1
    CLOSING_PAREN.lastIndex = doc.end
    return CLOSING_PAREN.test(cmd) ? CLOSING_PAREN.lastIndex : -1
  }
  LITERAL_ECHO.lastIndex = at
  return LITERAL_ECHO.test(cmd) ? LITERAL_ECHO.lastIndex : -1
}

/**
 * The offset of the first command or process substitution between `from` and
 * `to` whose output is unknown, outside single quotes, or -1 when there is
 * none. It skips the literal `$(cat <<'EOF' … )` that agents write commit
 * messages with.
 *
 * It follows quotes itself, over `code`: `cmd` with its comments and heredoc
 * bodies blanked, since an apostrophe in either would otherwise open a quote
 * that hides the code after it.
 */
export function opaqueSubstitutionAt(cmd: string, code: string, from: number, to: number): number {
  let quoted = false
  for (let i = from; i < to; i++) {
    const c = code[i]!
    if (c === '\\') {
      i++
    }
    else if (!quoted && c === '$' && code[i + 1] === '$' && code[i + 2] !== '(') {
      i++
    }
    else if (!quoted && c === '$' && code[i + 1] === '\'') {
      ANSI_C_STRING.lastIndex = i
      if (ANSI_C_STRING.test(code))
        i = ANSI_C_STRING.lastIndex - 1
    }
    else if (!quoted && c === '\'') {
      const close = code.indexOf('\'', i + 1)
      if (close >= 0)
        i = close
    }
    else if (c === '"') {
      quoted = !quoted
    }
    else if (c === '`' || (!quoted && (c === '<' || c === '>') && code[i + 1] === '(')) {
      return i
    }
    else if (c === '$') {
      const open = afterContinuations(code, i + 1)
      if (code[open] !== '(')
        continue
      const after = code[open + 1] === '(' ? -1 : literalSubstitutionEnd(cmd, open + 1)
      if (after < 0)
        return i
      i = after - 1
    }
  }
  return -1
}
