import { BLANKS, COMMENT_OPENER, HEREDOC_DELIMITER, LINE_PIECE, OPAQUE, SEGMENT, WORD } from './constants'

const blank = (text: string): string => '_'.repeat(text.length)

/** What `scrubShell` leaves of a quote or an escape: all of it, only a double-quoted string, or none. */
export type Keep = 'quotes' | 'double' | 'nothing'

// A comment and a line continuation become spaces; the blank that opened the
// comment is kept, so a newline still ends the line before it. `$$` is only
// matched so that its second `$` cannot open a quote, and so it stays.
function blankStretch(all: string, keep: Keep): string {
  if (all.startsWith('#')) {
    return ' '.repeat(all.length)
  }
  if (COMMENT_OPENER.test(all)) {
    return all[0] + ' '.repeat(all.length - 1)
  }
  if (keep === 'quotes' || all === '$$' || (keep === 'double' && all.startsWith('"'))) {
    return all
  }
  return all === '\\\n' ? '  ' : blank(all)
}

/**
 * Where each heredoc terminator could be: for every line that is one bare
 * word, the offset just past it. Bash ends a heredoc only on a line that is
 * exactly its delimiter (`<<-` also strips leading tabs), so a line that merely
 * starts with it, like `EOF '`, must not end one: its stray quote would hide
 * the code after it. Built once, so a run of unterminated `<<` openers stays
 * linear instead of each one searching the rest of the text.
 */
function lineLeaders(cmd: string, pattern: RegExp): Map<string, number[]> {
  const leaders = new Map<string, number[]>()
  for (const m of cmd.matchAll(pattern)) {
    const ends = leaders.get(m[1]!) ?? []
    ends.push(m.index + m[0].length)
    leaders.set(m[1]!, ends)
  }
  return leaders
}

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

/**
 * Blanks out every stretch a shell would treat as data rather than code —
 * heredoc bodies, quoted strings, escaped characters, comments — so that
 * command names and operators are matched only where they really are command
 * names and operators.
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
  const opaque = new RegExp(OPAQUE)
  const exact = lineLeaders(cmd, /^(\w+)$/gm)
  const tabbed = lineLeaders(cmd, /^\t*(\w+)$/gm)
  let out = ''
  let copied = 0
  for (let m = opaque.exec(cmd); m; m = opaque.exec(cmd)) {
    const [all, opener, , word] = m
    let replacement: string
    let end = m.index + all.length
    if (opener === undefined) {
      replacement = blankStretch(all, keep)
    }
    else {
      // The body starts on the line after the one the header ends, which a
      // backslash or an open quote can carry past the next newline.
      const headerStart = m.index + opener.length
      const lineEnd = logicalLineEnd(cmd, headerStart)
      const leaders = opener.startsWith('<<-') ? tabbed : exact
      // The terminator may be the body's first line.
      const terminatorEnd = lineEnd < 0 ? undefined : firstAtOrAfter(leaders.get(word!), lineEnd + 1)
      if (terminatorEnd === undefined) {
        opaque.lastIndex = m.index + 2
        continue
      }
      replacement = `<<${blank(opener.slice(2))}${scrubShell(cmd.slice(headerStart, lineEnd), keep)}${blank(cmd.slice(lineEnd, terminatorEnd))}`
      end = terminatorEnd
      opaque.lastIndex = end
    }
    out += cmd.slice(copied, m.index) + replacement
    copied = end
  }
  return out + cmd.slice(copied)
}

export interface Segment { readonly start: number, readonly text: string }

/** The offset that closes each `(` and each backquote that has a partner. */
function closers(scrubbed: string): Map<number, number> {
  const closing = new Map<number, number>()
  const open: number[] = []
  let tick = -1
  for (let i = 0; i < scrubbed.length; i++) {
    const char = scrubbed[i]
    if (char === '(') {
      open.push(i)
    }
    else if (char === ')' && open.length > 0) {
      closing.set(open.pop()!, i)
    }
    else if (char === '`') {
      if (tick < 0) {
        tick = i
      }
      else {
        closing.set(tick, i)
        tick = -1
      }
    }
  }
  return closing
}

/**
 * Every stretch between `;`, `&`, `|`, newlines, subshells and backticks, with
 * its offset. A command that holds a substitution is one stretch, the text
 * after the substitution included, so `git -C $(pwd) add -f .env` reads as the
 * git command it is; the commands inside the substitution follow as stretches
 * of their own.
 */
export function segments(scrubbed: string): Segment[] {
  const parts = [...scrubbed.matchAll(SEGMENT)].map(m => ({ start: m.index, text: m[0] }))
  if (!/\$\(|`/.test(scrubbed)) {
    return parts
  }
  const closing = closers(scrubbed)
  const byStart = new Map(parts.map(part => [part.start, part]))
  const joined = new Set<Segment>()
  const out: Segment[] = []
  for (const part of parts) {
    if (joined.has(part)) {
      continue
    }
    let end = part.start + part.text.length
    // A substitution opens where the stretch ends: at a backquote, or at the `(`
    // after a `$`. What follows its end is the same command.
    while (scrubbed[end] === '`' || (scrubbed[end] === '(' && scrubbed[end - 1] === '$')) {
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
      end = rest.start + rest.text.length
    }
    out.push({ start: part.start, text: scrubbed.slice(part.start, end) })
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

// Where the scans of the last command line ended, by the offset of each token
// they passed. A scan that reaches such a token ends where that one did, so a
// long continued line with a heredoc header on every row is walked once, not
// once per header.
let walked = { cmd: '', ends: new Map<number, number>() }

/**
 * The newline that ends the command line `from` is on, or -1. A backslash
 * continues the line, and a quote or a heredoc header can run over a newline
 * too; a newline inside a comment is where the comment ends.
 */
export function logicalLineEnd(cmd: string, from: number): number {
  const newline = cmd.indexOf('\n', from)
  // Only a quote or a backslash can carry the line past its first newline.
  if (newline < 0 || !/[\\'"]/.test(cmd.slice(from, newline))) {
    return newline
  }
  if (walked.cmd !== cmd) {
    walked = { cmd, ends: new Map() }
  }
  const passed: number[] = []
  const piece = new RegExp(LINE_PIECE)
  piece.lastIndex = from
  let end = -1
  for (let m = piece.exec(cmd); m; m = piece.exec(cmd)) {
    const known = walked.ends.get(m.index)
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
    walked.ends.set(at, end)
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
  HEREDOC_DELIMITER.lastIndex = at
  const delimiter = HEREDOC_DELIMITER.exec(cmd)
  if (!delimiter)
    return null
  const [all, dash, quote, word] = delimiter
  const lineEnd = logicalLineEnd(cmd, at + all.length)
  if (lineEnd < 0)
    return null
  const terminator = new RegExp(`^${dash ? '\\t*' : ''}${word}$`, 'm')
  const body = cmd.slice(lineEnd + 1)
  const found = terminator.exec(body)
  if (!found)
    return null
  return {
    body: body.slice(0, found.index),
    end: lineEnd + 1 + found.index + found[0].length,
    quoted: quote !== '' || all.includes('\\'),
    rest: cmd.slice(at + all.length, lineEnd),
  }
}
