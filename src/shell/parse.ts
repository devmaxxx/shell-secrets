import { BLANKS, COMMENT_OPENER, HEREDOC_DELIMITER, LINE_PIECE, MAX_QUOTED_PARTS, MAX_SCRIPT_DEPTH, OPAQUE, SEGMENT, WORD } from './constants'

const blank = (text: string): string => '_'.repeat(text.length)

/** What `scrubShell` leaves of a quote or an escape: all of it, only a double-quoted string, or none. */
export type Keep = 'quotes' | 'double' | 'nothing'

// A comment and a line continuation become spaces; the blank that opened the
// comment is kept, so a newline still ends the line before it. `$$` is only
// matched so that its second `$` cannot open a quote, and so it stays. A
// caller that looks for variables keeps the continuation too: `$\<newline>k`
// is `$k`.
function blankStretch(all: string, keep: Keep): string {
  if (all.startsWith('#')) {
    return ' '.repeat(all.length)
  }
  if (COMMENT_OPENER.test(all)) {
    return all[0] + ' '.repeat(all.length - 1)
  }
  if (keep === 'quotes' || all === '$$' || (keep === 'double' && (all.startsWith('"') || all === '\\\n'))) {
    return all
  }
  return all === '\\\n' ? '  ' : blank(all)
}

// A backslash makes the next character plain, `$` and backquote included.
function substitutionAt(text: string): number {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') {
      i++
    }
    else if (text[i] === '`' || (text[i] === '$' && text[i + 1] === '(')) {
      return i
    }
  }
  return -1
}

interface Exposed {
  readonly text: string
  /** A substitution is left without its closing parenthesis or backquote. */
  readonly open: boolean
}

// The shell runs a substitution inside double quotes, and what is in it is
// commands again, quoted on their own terms: `x="$(git add -f .env)"` runs
// git. The string is blanked all but the substitutions in it. Read as code
// from the first one, where the text between two is literal and its apostrophe
// or `#` can hide what follows, which only ever hides more.
//
// A substitution left open has its opener turned into a `;`: the commands in
// it are read to the end of the string, and no parenthesis is left to pair
// with a later one.
function exposeSubstitutions(quoted: string): Exposed {
  const inside = quoted.slice(1, -1)
  const first = substitutionAt(inside)
  if (first < 0) {
    return { text: blank(quoted), open: false }
  }
  const code = scrub(inside.slice(first), 'nothing', 0)
  let out = ''
  let depth = 0
  let backquoted = false
  let opened = 0
  for (let i = 0; i < code.length; i++) {
    const char = code[i]!
    if (backquoted) {
      backquoted = char !== '`'
    }
    else if (depth > 0) {
      depth += char === '(' ? 1 : char === ')' ? -1 : 0
    }
    else if (char === '`' || (char === '$' && code[i + 1] === '(')) {
      opened = out.length
      backquoted = char === '`'
      depth = backquoted ? 0 : 1
      out += backquoted ? char : '$('
      i += backquoted ? 0 : 1
      continue
    }
    else {
      out += '_'
      continue
    }
    out += char
  }
  const open = depth > 0 || backquoted
  if (open) {
    out = out.slice(0, opened) + (backquoted ? ';' : '_;') + out.slice(opened + (backquoted ? 1 : 2))
  }
  return { text: `_${blank(inside.slice(0, first))}${out}_`, open }
}

// A string ends at its next `"`, so one that holds a quoted word of its own,
// `"$(cd "$dir" && git add -f .env)"`, comes as a string, the word between
// the quotes, and a string that holds the rest. While the substitution is
// open the next string is joined to it and the whole is read again; when none
// closes it, the first stands alone, as the rest of the line would otherwise
// be read as the inside of a string.
function exposeQuoted(cmd: string, opaque: RegExp, first: RegExpExecArray, parts: number): { text: string, end: number } {
  const alone = exposeSubstitutions(first[0])
  const end = first.index + first[0].length
  if (!alone.open) {
    return { text: alone.text, end }
  }
  for (let joined = 1; joined < parts; joined++) {
    const next = opaque.exec(cmd)
    if (!next?.[0].startsWith('"')) {
      break
    }
    const whole = exposeSubstitutions(cmd.slice(first.index, next.index + next[0].length))
    if (!whole.open) {
      return { text: whole.text, end: next.index + next[0].length }
    }
  }
  opaque.lastIndex = end
  return { text: alone.text, end }
}

// A script nests at most `MAX_SCRIPT_DEPTH` deep, so this holds the texts it is inside of.
const MEMORY = MAX_SCRIPT_DEPTH + 2

/**
 * What `build` made of the last few texts it was given, by text. Command lines
 * nest (`bash -c '…'` is scanned inside the line that holds it), so a single
 * slot is lost to every inner call and the outer text is built again for each.
 */
function remember<T>(build: (text: string) => T): (text: string) => T {
  const made = new Map<string, T>()
  return (text) => {
    let value = made.get(text)
    if (value === undefined) {
      value = build(text)
      if (made.size >= MEMORY) {
        made.delete(made.keys().next().value!)
      }
    }
    else {
      made.delete(text)
    }
    made.set(text, value)
    return value
  }
}

interface Lines {
  readonly exact: ReadonlyMap<string, readonly number[]>
  readonly tabbed: ReadonlyMap<string, readonly number[]>
  /** Where the newlines stand. */
  readonly newlines: readonly number[]
  /** Where the quotes and backslashes stand: the only way a line goes on past its newline. */
  readonly carriers: readonly number[]
}

/**
 * Where each line ends, by what it says. Bash ends a heredoc only on a line
 * that is exactly its delimiter (`<<-` also strips leading tabs), so a line
 * that merely starts with it, like `EOF '`, must not end one: its stray quote
 * would hide the code after it. Built once for a text, so a run of
 * unterminated `<<` openers stays linear instead of each one searching the
 * rest of the text.
 */
const linesOf = remember((cmd): Lines => {
  const exact = new Map<string, number[]>()
  const tabbed = new Map<string, number[]>()
  const newlines: number[] = []
  const carriers: number[] = []
  const add = (lines: Map<string, number[]>, line: string, end: number): void => {
    const ends = lines.get(line)
    if (ends) {
      ends.push(end)
    }
    else {
      lines.set(line, [end])
    }
  }
  let start = 0
  for (;;) {
    const newline = cmd.indexOf('\n', start)
    const end = newline < 0 ? cmd.length : newline
    const line = cmd.slice(start, end)
    add(exact, line, end)
    add(tabbed, line.replace(/^\t+/, ''), end)
    if (newline < 0) {
      break
    }
    newlines.push(newline)
    start = newline + 1
  }
  for (const m of cmd.matchAll(/[\\'"]/g)) {
    carriers.push(m.index)
  }
  return { exact, tabbed, newlines, carriers }
})

function firstAtOrAfter(sorted: readonly number[] | undefined, from: number): number | undefined {
  if (!sorted) {
    return undefined
  }
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid]! < from) {
      lo = mid + 1
    }
    else {
      hi = mid
    }
  }
  return sorted[lo]
}

/** The end of the first line from `from` on that holds just `word`: a heredoc's terminator. */
function terminatorAfter(cmd: string, word: string, stripsTabs: boolean, from: number): number | undefined {
  const lines = linesOf(cmd)
  return firstAtOrAfter((stripsTabs ? lines.tabbed : lines.exact).get(word), from)
}

/**
 * Blanks out every stretch a shell would treat as data rather than code —
 * heredoc bodies, quoted strings, escaped characters, comments — so that
 * command names and operators are matched only where they really are command
 * names and operators. The commands of a substitution inside a double-quoted
 * string are code, and stay.
 *
 * The result has the same length as `cmd`, so an operator found in it can be
 * followed back to its operand in `cmd`. With `keep` set to `quotes` only the
 * comments and heredoc bodies go, for a caller that has to look inside quotes
 * but must not take an apostrophe in a comment for one; with `double` the
 * double-quoted strings stay as well, the one place besides plain text where a
 * shell expands a variable.
 *
 * Best effort by design: unbalanced quotes and unterminated heredocs are left
 * as code, which only ever makes a command look less harmless.
 */
export function scrubShell(cmd: string, keep: Keep = 'nothing'): string {
  return scrub(cmd, keep, MAX_QUOTED_PARTS)
}

// `parts` is how many strings a substitution in a double-quoted string may be
// joined from. A text that is read inside one is not joined again, so the
// work stays a few passes over it.
function scrub(cmd: string, keep: Keep, parts: number): string {
  const opaque = new RegExp(OPAQUE)
  let out = ''
  let copied = 0
  for (let m = opaque.exec(cmd); m; m = opaque.exec(cmd)) {
    const [all, opener, word] = m
    let replacement: string
    let end = m.index + all.length
    if (opener === undefined && keep === 'nothing' && all.startsWith('"')) {
      const exposed = exposeQuoted(cmd, opaque, m, parts)
      replacement = exposed.text
      end = exposed.end
    }
    else if (opener === undefined) {
      replacement = blankStretch(all, keep)
    }
    else {
      // The body starts on the line after the one the header ends, which a
      // backslash or an open quote can carry past the next newline.
      const headerStart = m.index + opener.length
      const lineEnd = logicalLineEnd(cmd, headerStart)
      // The terminator may be the body's first line.
      const terminatorEnd = lineEnd < 0 ? undefined : terminatorAfter(cmd, unquote(word!), opener.startsWith('<<-'), lineEnd + 1)
      if (terminatorEnd === undefined) {
        opaque.lastIndex = m.index + 2
        continue
      }
      replacement = `<<${blank(opener.slice(2))}${scrub(cmd.slice(headerStart, lineEnd), keep, parts)}${blank(cmd.slice(lineEnd, terminatorEnd))}`
      end = terminatorEnd
      opaque.lastIndex = end
    }
    out += cmd.slice(copied, m.index) + replacement
    copied = end
  }
  return out + cmd.slice(copied)
}

export interface Segment {
  readonly start: number
  readonly text: string
  /** The stretch whose substitution this one sits in; the stretches of one command line overlap. */
  readonly within?: Segment | undefined
  /**
   * The stretch before this one in the same place. A command in a substitution
   * that starts later but ends before the `|` is not the one piped in:
   * `cat .env $(echo x) | git commit -F -` is fed by the `cat`.
   */
  readonly before?: Segment | undefined
}

export const endOf = ({ start, text }: Segment): number => start + text.length

/**
 * Where the code of a stretch ends: a comment after it was blanked, and is no
 * word. Only a space or a tab is a blank to bash, so a `\r` before it stays.
 */
export function codeEnd({ start, text }: Segment): number {
  let end = text.length
  while (text[end - 1] === ' ' || text[end - 1] === '\t') {
    end--
  }
  return start + end
}

export interface Pairs {
  /** The offset that closes each `(` and each backquote that has a partner. */
  readonly closing: ReadonlyMap<number, number>
  /** Where the backquotes stand: quoted and escaped ones are blanked, so the rest alternate between opening and closing. */
  readonly ticks: readonly number[]
}

// Every segment of a command line asks, so building this afresh each time
// would make a line of `` `a` `` quadratic.
export const pairsOf = remember((scrubbed): Pairs => {
  const closing = new Map<number, number>()
  const ticks: number[] = []
  const open: number[] = []
  for (let i = 0; i < scrubbed.length; i++) {
    const char = scrubbed[i]
    if (char === '(') {
      open.push(i)
    }
    else if (char === ')' && open.length > 0) {
      closing.set(open.pop()!, i)
    }
    else if (char === '`') {
      if (ticks.length % 2 === 1) {
        closing.set(ticks.at(-1)!, i)
      }
      ticks.push(i)
    }
  }
  return { closing, ticks }
})

// A substitution opens at a backquote, or at the `(` after a `$`, `<` or `>`.
const opensSubstitution = (scrubbed: string, at: number): boolean => scrubbed[at] === '`' || (scrubbed[at] === '(' && /[$<>]/.test(scrubbed[at - 1] ?? ''))

/**
 * Every stretch between `;`, `&`, `|`, newlines, subshells and backticks, with
 * its offset. A command that holds a substitution is one stretch, the text
 * after the substitution included, so `git -C $(pwd) add -f .env` reads as the
 * git command it is; the commands inside the substitution follow as stretches
 * of their own.
 */
export function segments(scrubbed: string): Segment[] {
  const parts = [...scrubbed.matchAll(SEGMENT)].map(m => ({ start: m.index, text: m[0] }))
  const joins = /\$\(|[<>]\(|`/.test(scrubbed)
  const closing = joins ? pairsOf(scrubbed).closing : new Map<number, number>()
  const byStart = new Map(joins ? parts.map(part => [part.start, part]) : [])
  const joined = new Set<{ start: number, text: string }>()
  const out: Segment[] = []
  // The stretches whose substitution the next one may sit in.
  const open: Segment[] = []
  // The latest stretch of each place, to name the one before the next.
  const latest = new Map<Segment | undefined, Segment>()
  for (const part of parts) {
    if (joined.has(part)) {
      continue
    }
    while (open.length > 0 && open.at(-1)!.start + open.at(-1)!.text.length <= part.start) {
      open.pop()
    }
    let end = endOf(part)
    // What follows the end of a substitution that opens where the stretch ends
    // is the same command.
    while (opensSubstitution(scrubbed, end)) {
      const close = closing.get(end)
      if (close === undefined) {
        break
      }
      const rest = byStart.get(close + 1)
      if (!rest) {
        end = close + 1
        break
      }
      joined.add(rest)
      end = endOf(rest)
    }
    const within = open.at(-1)
    const segment: Segment = { start: part.start, text: scrubbed.slice(part.start, end), within, before: latest.get(within) }
    if (segment.text.trim() !== '') {
      latest.set(within, segment)
    }
    out.push(segment)
    if (end > endOf(part)) {
      open.push(segment)
    }
  }
  return out
}

/**
 * The word of `cmd` that starts at `index`, or `''` when an operator or the end
 * comes first. `end` is where the caller's stretch of code stops: a backquote
 * seen from inside its own pair would otherwise open a span that runs into the
 * next one, so a run of `` `tee x` `` would read the rest of the line from every
 * stretch.
 */
export function wordAt(cmd: string, index: number, end = cmd.length): string {
  WORD.lastIndex = index
  return WORD.exec(end < cmd.length ? cmd.slice(0, end) : cmd)?.[0] ?? ''
}

// Outside single quotes a backslash-newline only continues the line, and bash
// drops it: `gi\<newline>t` runs git.
const unescape = (char: string): string => char === '\n' ? '' : char

const ANSI_C_ESCAPE = /\\(?:x([\da-fA-F]{1,2})|([0-7]{1,3})|u([\da-fA-F]{1,4})|U([\da-fA-F]{1,8})|c([\s\S])|([\s\S]))/g

const ANSI_C_SINGLES: Readonly<Record<string, string>> = {
  'a': '\x07',
  'b': '\b',
  'e': '\x1B',
  'E': '\x1B',
  'f': '\f',
  'n': '\n',
  'r': '\r',
  't': '\t',
  'v': '\v',
  '\\': '\\',
  '\'': '\'',
  '"': '"',
  '?': '?',
}

// `$'\x2eenv'` is `.env`: a caller that compared the raw text would look up a
// file the shell never opens. Bash cuts the string at a NUL.
function decodeAnsiC(body: string): string {
  const text = body.replace(ANSI_C_ESCAPE, (all, hex?: string, octal?: string, short?: string, long?: string, control?: string, single?: string) => {
    if (hex !== undefined)
      return String.fromCharCode(Number.parseInt(hex, 16))
    if (octal !== undefined)
      return String.fromCharCode(Number.parseInt(octal, 8) & 0xFF)
    const wide = short ?? long
    if (wide !== undefined) {
      const code = Number.parseInt(wide, 16)
      return code > 0x10FFFF ? all : String.fromCodePoint(code)
    }
    return control === undefined ? ANSI_C_SINGLES[single!] ?? all : String.fromCharCode(control.charCodeAt(0) & 0x1F)
  })
  const nul = text.indexOf('\0')
  return nul < 0 ? text : text.slice(0, nul)
}

/**
 * Text as `echo -e` and `printf` print it. They read `\0nnn` as octal, which
 * `$'…'` reads as a NUL and then digits.
 */
export function decodeEscapes(text: string): string {
  return decodeAnsiC(text.replace(/\\(?:0([0-7]{1,3})|[\s\S])/g, (all, octal?: string) => octal === undefined ? all : String.fromCharCode(Number.parseInt(octal, 8) & 0xFF)))
}

/**
 * The word with its quotes and escapes removed, as the shell would pass it.
 * `$` and backticks survive, so a caller can still tell the word is not literal.
 */
export function unquote(word: string): string {
  return word.replace(
    /\$?"((?:[^"\\]|\\[\s\S])*)"|\$'((?:[^'\\]|\\[\s\S])*)'|'([^']*)'|\\([\s\S])/g,
    (_all, double: string | undefined, ansi: string | undefined, single: string | undefined, escaped: string | undefined) => {
      if (double !== undefined)
        return double.replace(/\\(["\\$`\n])/g, (_escape, char: string) => unescape(char))
      return ansi === undefined ? single ?? unescape(escaped!) : decodeAnsiC(ansi)
    },
  )
}

export function hasSubstitution(cmd: string): boolean {
  return /\$\(|`/.test(cmd)
}

export function skipBlanks(cmd: string, at: number): number {
  BLANKS.lastIndex = at
  return at + BLANKS.exec(cmd)![0].length
}

// Where the scans of a command line ended, by the offset of each token they
// passed. A scan that reaches such a token ends where that one did, so a long
// continued line with a heredoc header on every row is walked once, not once
// per header.
const walkedOf = remember(() => new Map<number, number>())

/**
 * The newline that ends the command line `from` is on, or -1. A backslash
 * continues the line, and a quote or a heredoc header can run over a newline
 * too; a newline inside a comment is where the comment ends.
 */
export function logicalLineEnd(cmd: string, from: number): number {
  const { newlines, carriers } = linesOf(cmd)
  const newline = firstAtOrAfter(newlines, from) ?? -1
  // Only a quote or a backslash can carry the line past its first newline.
  if (newline < 0 || (firstAtOrAfter(carriers, from) ?? newline) >= newline) {
    return newline
  }
  const walked = walkedOf(cmd)
  const passed: number[] = []
  const piece = new RegExp(LINE_PIECE)
  piece.lastIndex = from
  let end = -1
  for (let m = piece.exec(cmd); m; m = piece.exec(cmd)) {
    const known = walked.get(m.index)
    if (known !== undefined) {
      end = known
      break
    }
    if (m[0] === '\n') {
      end = m.index
      break
    }
    passed.push(m.index)
  }
  for (const at of passed) {
    walked.set(at, end)
  }
  return end
}

/** Where `at` is once the backslash-newlines there are skipped, as the shell joins them. */
export function afterContinuations(cmd: string, at: number): number {
  let next = at
  while (cmd[next] === '\\' && cmd[next + 1] === '\n') {
    next += 2
  }
  return next
}

export interface Heredoc {
  readonly body: string
  /** Offset just past the terminator line. */
  readonly end: number
  /** A quoted delimiter keeps the body literal; a bare one expands `$(…)` in it. */
  readonly quoted: boolean
  /** Whatever follows the delimiter on its own line. */
  readonly rest: string
}

/** The heredoc whose `<<` ends just before `at`, or `null` when it is not terminated. */
export function heredocAt(cmd: string, at: number): Heredoc | null {
  const stripsTabs = cmd[at] === '-'
  HEREDOC_DELIMITER.lastIndex = stripsTabs ? at + 1 : at
  const delimiter = HEREDOC_DELIMITER.exec(cmd)
  if (!delimiter)
    return null
  const raw = delimiter[1]
  const word = unquote(raw!)
  const delimiterEnd = HEREDOC_DELIMITER.lastIndex
  const lineEnd = logicalLineEnd(cmd, delimiterEnd)
  const end = lineEnd < 0 ? undefined : terminatorAfter(cmd, word, stripsTabs, lineEnd + 1)
  if (end === undefined)
    return null
  return {
    // The terminator line is the last one before `end`.
    body: cmd.slice(lineEnd + 1, cmd.lastIndexOf('\n', end - 1) + 1),
    end,
    quoted: word !== raw,
    rest: cmd.slice(delimiterEnd, lineEnd),
  }
}
