import type { Heredoc, Segment } from './parse'
import { ANSI_C_STRING, ARGUMENTS_FROM_STDIN, CAT_HEREDOC, CLOSING_PAREN, COMMAND_RUNNERS, CURL_BODY, CURL_FILE_VALUE, CURL_GRAMMAR, ECHO_GUARD, ENV_VALUED_OPTION, FIELD_FROM_FILE, GH_ALIASES, GH_FIELD_OPTIONS, GH_GRAMMARS, GH_WRITES, GIT_GRAMMARS, GIT_PLACE_OPTION, GIT_VALUED_GLOBAL, HTTPIE_DATA, HTTPIE_FILE, HTTPIE_GRAMMAR, IDENTITY_ASSIGNMENT, IDENTITY_CONFIG, LEADING_EXPANSIONS, LITERAL_ECHO, LOGIN_OPTION, MAX_BRACE_WORDS, MAX_COMMAND_CANDIDATES, MAX_SPREAD_WORDS, NETCATS, OVERRIDES_PRINTER, PRINTED_WORDS, REDIRECT_OPERATOR, REMOTE_TARGET, RSYNC_GRAMMAR, RUNNER_COMMAND_OPTION, SCP_GRAMMAR, SHELL_COMMAND_OPTION, SHELL_STDIN_OPTION, SHELL_VALUED_LONG_OPTION, SHELLS, SPLIT_STRING_OPTION, UPLOADERS, WATCH_VALUED_OPTION, WGET_BODY, WGET_GRAMMAR } from './constants'
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

interface Word {
  readonly value: string
  readonly at: number
  readonly end: number
  /** One of the words a brace group spread the source word into: the brace-free glob it reads as, quoting kept as backslashes. They share the source word's offsets. */
  readonly pattern?: string
  /** A brace group too wide to list stands in the word, so what the shell makes of it is unknown. */
  readonly unread?: true
}

interface Option { readonly name: string, readonly value: string | undefined, readonly valued: boolean, readonly at: number }

interface Parsed { readonly options: Option[], readonly operands: string[] }

/**
 * A segment's words, the offset after each `<<`, and the text of each
 * here-string. `vague` is set when a brace group made a word that may be no
 * word at all, and the words stand for the reading that drops it.
 */
interface Spoken { readonly words: Word[], readonly heredocs: number[], readonly hereStrings: string[], readonly vague: boolean }

const COMMANDS = new Set(['git', 'gh', 'eval', ...SHELLS])

const NOTHING: Publication = Object.freeze({ publishes: false, content: false, files: [], unresolved: [], scripts: [], elsewhere: false, stdinScript: false, from: 0, identity: Number.POSITIVE_INFINITY })

// A publication whose files cannot be named: the caller blocks the call
// rather than pass what it cannot see.
const unreadable = (text: string, content = false): Publication => ({ ...NOTHING, publishes: true, content, unresolved: [text] })

const withoutLeadingExpansions = (text: string): string => text.slice(LEADING_EXPANSIONS.exec(text)?.[0].length ?? 0)

// The command a word names, past the expansions glued before it: `${X}git`
// runs git when X is empty. A word a brace group spread out has its own value,
// where the source text is the group.
function nameOf(cmd: string, word: Word): string {
  const name = word.pattern === undefined ? unquote(withoutLeadingExpansions(cmd.slice(word.at, word.end))) : withoutLeadingExpansions(word.value)
  // zsh expands `=git` to the path of git.
  return name.startsWith('=') && !name.includes('/') ? name.slice(1) : name.slice(name.lastIndexOf('/') + 1)
}

const isFilledIn = (word: string): boolean => /[$`]/.test(word)

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
      // Like unquote, a backslash-newline only continues the line and is dropped.
      if (i + 1 < raw.length && raw[++i] !== '\n') {
        literal(raw[i]!)
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
    else if (c === '"' || (c === '$' && raw[i + 1] === '"')) {
      // `$"…"` is a double-quoted string the shell may translate: read as the string.
      if (c === '$') {
        i++
      }
      let end = i + 1
      while (end < raw.length && raw[end] !== '"') {
        end += raw[end] === '\\' ? 2 : 1
      }
      literal(raw.slice(i + 1, end).replace(/\\(["\\$`\n])/g, (_escape, char: string) => char === '\n' ? '' : char))
      i = end
    }
    else {
      out += c
    }
  }
  return out
}

// The words a pattern spreads into when the shell expands its brace groups, or
// `null` when it would spread past the bound: too many words, or too many `{`
// probed. A pattern with no group comes back whole. Only the first group on a
// path is split; the rest follow the recursion.
function expandBraces(pattern: string): string[] | null {
  const out: string[] = []
  // A `{` that opens no group is scanned to the line's end, so a run of them is
  // bounded too, not only the words and the nesting the recursion reaches.
  let probes = 0
  const expand = (prefix: string, rest: string): boolean => {
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '\\') {
        i++
      }
      else if (rest[i] === '$' && rest[i + 1] === '{') {
        // The braces of `${…}` belong to the parameter, whatever commas it holds.
        probes++
        i = parameterEnd(rest, i + 1)
      }
      else if (rest[i] === '{') {
        probes++
        const group = braceGroup(rest, i)
        if (group === 'wide') {
          return false
        }
        if (group) {
          return group.parts.every(alt => expand(prefix + rest.slice(0, i), alt + rest.slice(group.end)))
        }
      }
      if (probes > MAX_BRACE_WORDS) {
        return false
      }
    }
    if (out.length === MAX_BRACE_WORDS) {
      return false
    }
    out.push(prefix + rest)
    return true
  }
  return expand('', pattern) ? out : null
}

// Where the `}` stands that closes the `${` whose brace is at `open`, or `open`
// when none does.
function parameterEnd(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '\\') {
      i++
    }
    else if (text[i] === '{') {
      depth++
    }
    else if (text[i] === '}' && --depth === 0) {
      return i
    }
  }
  return open
}

// The words of the brace group that opens at `open`, comma-separated or a
// sequence, and where it closes; `null` when it is no group (one word between
// braces, or unbalanced), `'wide'` for a sequence past the bound.
function braceGroup(pattern: string, open: number): { parts: string[], end: number } | 'wide' | null {
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
      if (parts.length > 0) {
        parts.push(pattern.slice(start, i))
        return { parts, end: i + 1 }
      }
      const sequence = sequenceOf(pattern.slice(open + 1, i))
      return sequence === 'wide' || sequence === null ? sequence : { parts: sequence, end: i + 1 }
    }
  }
  return null
}

// `1..3`, `a..e` and `1..9..2` as the shell lists them, `null` for text that is
// no sequence (`1..a`), `'wide'` past the bound. Zero padding follows an end
// written with a leading zero.
function sequenceOf(body: string): string[] | 'wide' | null {
  const match = /^(-?\d+|[a-z])\.\.(-?\d+|[a-z])(?:\.\.(-?\d+))?$/i.exec(body)
  if (!match) {
    return null
  }
  const [, from, to, by] = match as unknown as [string, string, string, string | undefined]
  const numeric = /\d/.test(from)
  if (numeric !== /\d/.test(to)) {
    return null
  }
  const [first, last] = numeric ? [Number(from), Number(to)] : [from.charCodeAt(0), to.charCodeAt(0)]
  const step = Math.abs(Number(by ?? 1)) || 1
  const count = Math.floor(Math.abs(last - first) / step) + 1
  // Not `count > MAX`: a number too large to hold makes it NaN.
  if (!(count <= MAX_BRACE_WORDS)) {
    return 'wide'
  }
  const width = numeric && (/^-?0\d/.test(from) || /^-?0\d/.test(to)) ? Math.max(from.replace('-', '').length, to.replace('-', '').length) : 0
  return Array.from({ length: count }, (_, k) => {
    const n = first + (first <= last ? 1 : -1) * step * k
    return numeric ? `${n < 0 ? '-' : ''}${String(Math.abs(n)).padStart(width, '0')}` : String.fromCharCode(n)
  })
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
    const next = c === '[' ? matchClass(pattern, p, text[t]!) : -1
    if (c === '*') {
      star = p++
      mark = t
    }
    else if (c === '?' || c === text[t]) {
      p++
      t++
    }
    else if (next >= 0) {
      p = next
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

// What matchClass does not read: a POSIX set in a class (`[[:alpha:]]`,
// `[[=i=]]`, `[[.i.]]`) and an escaped `]`.
const UNREAD_GLOB = /\[[:=.]|\\\]/

// Whether the command word, read unquoted as a glob, could name git or gh.
// Scrubbing blanks quoted parts, so a `* ? [` still standing in `scrubbed` was
// unquoted and is a wildcard; the pattern is read from `cmd`, where the quoting
// tells a wildcard from a literal filename character, and a word a brace group
// spread out carries its own. Only git and gh are tried, as for a name the shell
// fills in: a glob that spells another command (`cur[l]`, `ba*h`) goes unread.
// A word marked unread, or holding what UNREAD_GLOB lists, may name either.
function isGlobName(cmd: string, scrubbed: string, word: Word): boolean {
  if (word.unread) {
    return true
  }
  if (word.pattern === undefined && !/[*?[]/.test(scrubbed.slice(word.at, word.end))) {
    return false
  }
  const pattern = word.pattern === undefined ? globPattern(withoutLeadingExpansions(cmd.slice(word.at, word.end))) : withoutLeadingExpansions(word.pattern)
  const base = pattern.slice(pattern.lastIndexOf('/') + 1)
  return UNREAD_GLOB.test(base) || globMatches(base, 'git') || globMatches(base, 'gh')
}

// What a substitution reads as inside a brace group: one name for whatever the
// shell fills in.
const FILLED_IN = '$_'

// An empty word, or a substitution that may print nothing, is no word in bash
// and an empty argument in zsh.
const mayVanish = (word: string): boolean => word === '' || word === FILLED_IN

// `raw`, a word that starts at `at`, with each substitution in it (`$(…)`, a
// backquoted one, `<(…)`) read as a single name. The `closing` map holds only
// the ones outside single quotes and escapes.
function withoutSubstitutions(raw: string, at: number, closing: ReadonlyMap<number, number>): string {
  let out = ''
  for (let i = 0; i < raw.length;) {
    const open = raw[i] === '`' ? i : /[$<>]/.test(raw[i]!) && raw[i + 1] === '(' ? i + 1 : -1
    const close = open < 0 ? undefined : closing.get(at + open)
    if (close === undefined || close - at >= raw.length) {
      out += raw[i++]
    }
    else {
      out += FILLED_IN
      i = close - at + 1
    }
  }
  return out
}

// The words an unquoted brace group in `raw` makes of it (`{git,add}` is two,
// `/usr/bin/{git,gh}` is two), each as the glob pattern it reads as, empty ones
// included. `undefined` when it holds no group (`${HOME}`, `{}`, a quoted
// `"{a,b}"`) or only a substitution's, whose braces belong to the command inside
// it; `null` when it spreads past the bound.
function spreadOf(raw: string, at: number, closing: ReadonlyMap<number, number>): string[] | null | undefined {
  if (!raw.includes('{')) {
    return undefined
  }
  const pattern = globPattern(withoutSubstitutions(raw, at, closing))
  const spread = expandBraces(pattern)
  if (spread === null) {
    return null
  }
  return spread.length > 1 || spread[0] !== pattern ? spread : undefined
}

const GH_GROUPS = new Set(Object.keys(GH_GRAMMARS).map(key => key.split(' ')[0]!))

// Where a substitution that opens in `word[from…]`, a word that starts at `at`,
// closes past the word's end, and before `end`.
function closesPast(word: string, from: number, at: number, end: number, closing: ReadonlyMap<number, number>): number | undefined {
  for (let i = word.indexOf('(', from); i >= 0; i = word.indexOf('(', i + 1)) {
    const close = i > 0 && /[$<>]/.test(word[i - 1]!) ? closing.get(at + i) : undefined
    if (close !== undefined && close >= at + word.length && close < end) {
      return close
    }
  }
  return undefined
}

// The word at `at`, with a substitution the word pattern cannot read, one
// nested deeper than it counts or a process substitution, taken through the
// parenthesis that closes it. Dropping the rest of the segment there would hide
// the command that stands after `FOO=$(…) `. The pattern ends a substitution at
// the first `)` that balances, which for `$(case a in a) …;; esac)` is the one
// that ends the pattern, and what follows is its words, not the command's.
function wordFrom(cmd: string, at: number, end: number, closing: ReadonlyMap<number, number>): string {
  let word = wordAt(cmd, at, end)
  let read = 0
  for (;;) {
    const next = at + word.length
    const open = cmd[next] === '(' && word.endsWith('$') ? next : /[<>]/.test(cmd[next] ?? '') && cmd[next + 1] === '(' ? next + 1 : -1
    let close = open < 0 ? undefined : closing.get(open)
    if (close === undefined) {
      close = closesPast(word, read, at, end, closing)
      read = word.length
    }
    if (close === undefined || close >= end) {
      return word
    }
    word += cmd.slice(next, close + 1) + wordAt(cmd, close + 1, end)
  }
}

/**
 * The segment's words as the shell passes them, unquoted, with redirects and
 * their targets left out. A word of a brace group that may be no word is left
 * out (bash drops an empty one) unless `keepEmpty` keeps it (zsh passes it on).
 */
function wordsOf(cmd: string, segment: Segment, closing: ReadonlyMap<number, number>, keepEmpty = false): Spoken {
  const end = codeEnd(segment)
  const words: Word[] = []
  const heredocs: number[] = []
  const hereStrings: string[] = []
  let vague = false
  let spare = MAX_SPREAD_WORDS
  let at = skipBlanks(cmd, segment.start)
  while (at < end) {
    const raw = wordFrom(cmd, at, end, closing)
    if (raw && !(/^\d+$/.test(raw) && /[<>]/.test(cmd[at + raw.length] ?? ''))) {
      const listed = spreadOf(raw, at, closing)
      const spread = keepEmpty || !listed ? listed : listed.filter(word => !mayVanish(word))
      vague ||= !!listed && listed.length !== spread?.length
      const stop = at + raw.length
      const extra = spread ? Math.max(spread.length - 1, 0) : 0
      if (spread && extra <= spare) {
        spare -= extra
        for (const pattern of spread)
          words.push({ value: pattern.replace(/\\([\s\S])/g, '$1'), at, end: stop, pattern })
      }
      else {
        const word = { value: unquote(raw), at, end: stop }
        words.push(spread === undefined ? word : { ...word, unread: true })
      }
      at = skipBlanks(cmd, stop)
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
  return { words, heredocs, hereStrings, vague }
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
  // A brace group too wide to list can stand for an option or the subcommand.
  if (words.some(w => w.unread))
    return guessed ? NOTHING : unreadable(text)
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
    // git fails on an empty pathspec, so it names no file to scan; zsh leaves
    // one where a brace alternative is empty, as in `git add {,-f} x`.
    publication.files.push(...(all ? ['.'] : parsed.operands.filter(operand => operand !== '')))
    return publication
  }
  // A stash publishes only through its message: `git stash [push] -m <msg>`,
  // `git stash save <msg>` or `git stash create <msg>`, like a commit message.
  // Listing or popping does not.
  if (sub === 'stash') {
    const saves = (parsed.operands[0] === 'save' || parsed.operands[0] === 'create') && parsed.operands.length > 1
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
  if (words.some(w => w.unread))
    return guessed ? NOTHING : unreadable(text)
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

// The files curl sends: a request body, a form field, an upload or header lines,
// each from a file the option's value points at. `@-` and `-T -` send stdin.
function curlFiles(parsed: Parsed, publication: Publication, text: string): void {
  for (const option of parsed.options) {
    const file = CURL_FILE_VALUE.get(option.name)?.exec(option.value ?? '')?.[1]
    if (file !== undefined)
      addFile(file, publication, text)
  }
}

// Where the first of the `names` options starts whose value the shell fills in,
// or Infinity: the body it sends is then the output of a command or the content
// of a variable, which the line does not show (`-d "$(cat .env)"`).
function filledBody(parsed: Parsed, names: ReadonlySet<string>): number {
  const filled = parsed.options.find(o => names.has(o.name.replace(/^expand-/, '')) && isFilledIn(o.value ?? ''))
  return filled?.at ?? Number.POSITIVE_INFINITY
}

// The local files a copy to a remote host sends: with a remote destination
// last, every source that is not itself remote. A copy between local paths, or
// one that only pulls down, sends nothing. The `;` that ends a `find -exec`
// and a word the shell fills in, which may be empty, can stand after the
// destination without moving it.
function remoteFiles(words: readonly Word[], grammar: Grammar, publication: Publication, text: string): void {
  const { operands } = parse(words, grammar)
  let target = operands.length - 1
  while (target > 0 && !REMOTE_TARGET.test(operands[target]!) && (operands[target] === ';' || isFilledIn(operands[target]!)))
    target--
  if (target < 1 || !REMOTE_TARGET.test(operands[target]!))
    return
  for (const source of operands.slice(0, target).filter(path => !REMOTE_TARGET.test(path)))
    addFile(source, publication, text)
}

// A command that reads a file and sends it off the machine. Each file is
// published as a message file is, so its contents are scanned and an ignored
// one holding a secret still blocks; netcat and httpie send their stdin, read as
// `-`. A body the shell fills in is content like a commit message's. With no
// word after the name it is only mentioned, as in `grep nc` or
// `pip install httpie`, and nothing is sent.
function uploaded(name: string, words: readonly Word[], text: string): Publication {
  if (words.length === 0)
    return NOTHING
  const publication: Publication = { ...NOTHING, publishes: true, files: [], unresolved: [] }
  let body = Number.POSITIVE_INFINITY
  if (name === 'curl') {
    const parsed = parse(words, CURL_GRAMMAR)
    curlFiles(parsed, publication, text)
    body = filledBody(parsed, CURL_BODY)
  }
  else if (name === 'wget') {
    const parsed = parse(words, WGET_GRAMMAR)
    optionFiles(parsed, WGET_GRAMMAR, publication, text)
    body = filledBody(parsed, WGET_BODY)
  }
  else if (name === 'http' || name === 'https' || name === 'httpie') {
    const parsed = parse(words, HTTPIE_GRAMMAR)
    // `[METHOD] URL [ITEM…]`: a first word of letters only is the method, and the
    // URL after it is no request item.
    const items = parsed.operands.slice(/^[a-z]+$/i.test(parsed.operands[0] ?? '') ? 2 : 1)
    for (const item of items) {
      const file = HTTPIE_FILE.exec(item)
      if (file)
        addFile(file[1], publication, text)
    }
    if (items.some(item => isFilledIn(HTTPIE_DATA.exec(item)?.[1] ?? '')))
      body = words[0]!.at
    // Input redirected to it is the request body.
    if (!has(parsed, 'ignore-stdin'))
      addFile('-', publication, text)
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
  if (body < Number.POSITIVE_INFINITY)
    return { ...publication, content: true, from: body }
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
 * What a segment publishes through git or gh, or sends off the machine with an
 * uploader such as curl, scp or nc. The command is found by name wherever it
 * stands, unquoted (`'git'`, `\git`, `/usr/bin/git`), so a wrapper this does not
 * know (`nice`, `timeout 5`, `find -exec`) cannot hide it, at worst it reads a
 * file that is not one. A name the shell fills in (`$g`, `$(which git)`) is
 * read as git or gh, whichever its arguments would make publish, and a git or gh
 * subcommand the shell fills in is unknown. Arguments built from stdin by
 * `xargs` or `parallel` cannot be read.
 */
export function publicationOf(cmd: string, scrubbed: string, segment: Segment): Publication {
  const { closing } = pairsOf(scrubbed)
  const spoken = wordsOf(cmd, segment, closing)
  const publication = publicationFrom(cmd, scrubbed, segment, spoken)
  if (!spoken.vague) {
    return publication
  }
  // A word of a brace group that may be empty (`{,-d}`, `{-f,$(true)}`) is no
  // word in bash and an empty argument in zsh, which moves the value an option
  // before it takes: the line is read both ways.
  return merged(publication, publicationFrom(cmd, scrubbed, segment, wordsOf(cmd, segment, closing, true)))
}

// What the line publishes if either reading of it holds.
function merged(a: Publication, b: Publication): Publication {
  if (a === NOTHING || b === NOTHING) {
    return a === NOTHING ? b : a
  }
  return {
    publishes: a.publishes || b.publishes,
    content: a.content || b.content,
    files: [...a.files, ...b.files],
    unresolved: [...a.unresolved, ...b.unresolved],
    scripts: [...a.scripts, ...b.scripts],
    elsewhere: a.elsewhere || b.elsewhere,
    stdinScript: a.stdinScript || b.stdinScript,
    from: Math.min(a.from, b.from),
    identity: Math.min(a.identity, b.identity),
  }
}

function publicationFrom(cmd: string, scrubbed: string, segment: Segment, spoken: Spoken): Publication {
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
  let netcat: Publication | undefined
  for (; command < words.length && tried < MAX_COMMAND_CANDIDATES; command++) {
    const name = nameOf(cmd, words[command]!)
    fromStdin ||= ARGUMENTS_FROM_STDIN.has(name)
    if (!isCandidate(name, words[command]!) && !isGlobName(cmd, scrubbed, words[command]!)) {
      continue
    }
    tried++
    const publication = tryCommand(cmd, spoken, command, fromStdin, text)
    if (publication.publishes || publication.scripts.length > 0 || publication.stdinScript) {
      // netcat sends only its stdin. When the name is an option's value
      // (`env -u nc git add -f .env`), the git after it is what publishes.
      if (NETCATS.has(name)) {
        netcat ??= publication
        continue
      }
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
  return netcat ?? NOTHING
}

/** A `$(…)` whose output is text the command already shows. */
interface LiteralSubstitution {
  /** The offset after its closing paren. */
  readonly end: number
  /**
   * Every text it may print, or `undefined` when the shell would have to
   * expand a word to tell: a heredoc, a brace, a glob or an escape.
   */
  readonly prints: readonly string[] | undefined
}

// What an echo or printf of plain and quoted words prints. zsh's echo reads
// escapes without `-e`, so a word with a backslash is left unspelled, and
// printf only when its format holds no conversion for the words to fill. A
// quote keeps a brace or `~` from expanding, but not a glob in the output:
// bash globs an unquoted substitution's words, and git a pathspec in any shell.
function printedText(printer: string, words: string): string | undefined {
  const raw = words.match(PRINTED_WORDS) ?? []
  if (raw.some(word => /[{~]/.test(word.replace(/"[^"]*"|'[^']*'/g, ''))))
    return undefined
  const args = raw.map(unquote)
  if (args.some(arg => /[\\*?[]/.test(arg)))
    return undefined
  if (printer === 'printf')
    return args[0] === undefined || /^-|%/.test(args[0]) ? undefined : args[0]
  let first = 0
  while (first < args.length && /^-[neE]+$/.test(args[first]!))
    first++
  return args.slice(first).join(' ')
}

function literalSubstitution(cmd: string, at: number): LiteralSubstitution | null {
  CAT_HEREDOC.lastIndex = at
  if (CAT_HEREDOC.test(cmd)) {
    const doc = heredocAt(cmd, CAT_HEREDOC.lastIndex)
    if (!doc || doc.rest.trim() !== '' || (!doc.quoted && /\$\(|`/.test(doc.body)))
      return null
    CLOSING_PAREN.lastIndex = doc.end
    return CLOSING_PAREN.test(cmd) ? { end: CLOSING_PAREN.lastIndex, prints: undefined } : null
  }
  ECHO_GUARD.lastIndex = at
  const guarded = ECHO_GUARD.test(cmd)
  LITERAL_ECHO.lastIndex = guarded ? ECHO_GUARD.lastIndex : at
  const echo = LITERAL_ECHO.exec(cmd)
  if (!echo)
    return null
  const { printer, words } = echo.groups as { printer: string, words: string }
  const text = printedText(printer, words)
  // A guarded echo is let through only when what it prints is known, so the
  // words it may add to the command are read; a bare one keeps what earlier
  // versions let through, quotes and escapes aside.
  if (text === undefined && (guarded || /['"\\]/.test(words)))
    return null
  const prints = text === undefined ? undefined : guarded ? ['', text] : [text]
  return { end: LITERAL_ECHO.lastIndex, prints }
}

/**
 * Walks the command and process substitutions between `from` and `to` that
 * stand outside single quotes. With `literals` false, as on a line that defines
 * its own `echo` or `test`, none is literal. `visit` gets each one with whether it stands in
 * double quotes, and its literal reading or `null` when its output is unknown;
 * it returns `true` to stop. A literal one is stepped over, an unknown one into.
 *
 * It follows quotes itself, over `code`: `cmd` with its comments and heredoc
 * bodies blanked, since an apostrophe in either would otherwise open a quote
 * that hides the code after it.
 */
function walkSubstitutions(cmd: string, code: string, from: number, to: number, literals: boolean, visit: (at: number, quoted: boolean, literal: LiteralSubstitution | null) => boolean): void {
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
      if (visit(i, quoted, null))
        return
    }
    else if (c === '$') {
      const open = afterContinuations(code, i + 1)
      if (code[open] !== '(')
        continue
      const literal = !literals || code[open + 1] === '(' ? null : literalSubstitution(cmd, open + 1)
      if (visit(i, quoted, literal))
        return
      if (literal)
        i = literal.end - 1
    }
  }
}

/**
 * The offset of the first command or process substitution between `from` and
 * `to` whose output is unknown, outside single quotes, or -1 when there is
 * none. It skips the literal `$(cat <<'EOF' … )` that agents write commit
 * messages with, a plain `$(echo …)`, and an echo behind a test.
 */
export function opaqueSubstitutionAt(cmd: string, code: string, from: number, to: number, literals = true): number {
  let found = -1
  walkSubstitutions(cmd, code, from, to, literals, (at, _quoted, literal) => {
    if (literal)
      return false
    found = at
    return true
  })
  return found
}

/** Whether `echo`, `printf` and `test` on this line are the shell's own, not a function it defines. */
export function printsOwnText(code: string): boolean {
  return !OVERRIDES_PRINTER.test(code)
}

/** A literal substitution and the texts the shell may put in its place. */
export interface Splice {
  readonly start: number
  readonly end: number
  readonly quoted: boolean
  readonly prints: readonly string[]
}

/**
 * The literal substitutions whose output can be spelled out. What one prints
 * becomes words of the command: `git tag $(echo -F msg) v1` reads `msg` as
 * surely as `git tag -F msg v1`, so a caller reads the command again with each
 * spelled in.
 */
export function literalSplices(cmd: string, code: string): Splice[] {
  const splices: Splice[] = []
  if (!printsOwnText(code))
    return splices
  walkSubstitutions(cmd, code, 0, cmd.length, true, (start, quoted, literal) => {
    if (literal?.prints)
      splices.push({ start, end: literal.end, quoted, prints: literal.prints })
    return false
  })
  return splices
}
