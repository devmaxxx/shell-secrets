import { OPAQUE, SEGMENT, WORD } from './constants'

const blank = (text: string): string => '_'.repeat(text.length)

// A comment and a line continuation become spaces; the blank that opened the
// comment is kept, so a newline still ends the line before it.
function blankStretch(all: string): string {
  if (all === '\\\n') {
    return '  '
  }
  if (all.startsWith('#')) {
    return ' '.repeat(all.length)
  }
  if (/^\s#/.test(all)) {
    return all[0] + ' '.repeat(all.length - 1)
  }
  return blank(all)
}

/**
 * Where each heredoc terminator could be: for every word that starts a line,
 * the offsets just past it. Built once, so a run of unterminated `<<` openers
 * stays linear instead of each one searching the rest of the text.
 */
function lineLeaders(cmd: string): Map<string, number[]> {
  const leaders = new Map<string, number[]>()
  for (const m of cmd.matchAll(/^[ \t]*(\w+)/gm)) {
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
 * followed back to its operand in `cmd`.
 *
 * Best effort by design: unbalanced quotes and unterminated heredocs are left
 * as code, which only ever makes a command look less harmless.
 */
export function scrubShell(cmd: string): string {
  const opaque = new RegExp(OPAQUE)
  const leaders = lineLeaders(cmd)
  let out = ''
  let copied = 0
  for (let m = opaque.exec(cmd); m; m = opaque.exec(cmd)) {
    const [all, opener, , word, header] = m
    let replacement: string
    let end = m.index + all.length
    if (opener === undefined) {
      replacement = blankStretch(all)
    }
    else {
      // The body starts on the next line; the terminator may be its first line.
      const terminatorEnd = firstAtOrAfter(leaders.get(word!), end)
      if (terminatorEnd === undefined) {
        opaque.lastIndex = m.index + 2
        continue
      }
      replacement = `<<${blank(opener.slice(2))}${scrubShell(header!)}${blank(cmd.slice(m.index + opener.length + header!.length, terminatorEnd))}`
      end = terminatorEnd
      opaque.lastIndex = end
    }
    out += cmd.slice(copied, m.index) + replacement
    copied = end
  }
  return out + cmd.slice(copied)
}

/** Every stretch between `;`, `&`, `|`, newlines, subshells and backticks, with its offset. */
export function segments(scrubbed: string): { start: number, text: string }[] {
  return [...scrubbed.matchAll(SEGMENT)].map(m => ({ start: m.index, text: m[0] }))
}

/** The word of `cmd` that starts at `index`, or `''` when an operator or the end comes first. */
export function wordAt(cmd: string, index: number): string {
  WORD.lastIndex = index
  return WORD.exec(cmd)?.[0] ?? ''
}

/**
 * The word with its quotes and escapes removed, as the shell would pass it.
 * `$` and backticks survive, so a caller can still tell the word is not literal.
 */
export function unquote(word: string): string {
  return word.replace(
    /"((?:[^"\\]|\\[\s\S])*)"|'([^']*)'|\\([\s\S])/g,
    (_all, double: string | undefined, single: string | undefined, escaped: string | undefined) =>
      double !== undefined ? double.replace(/\\(["\\$`])/g, '$1') : (single ?? escaped)!,
  )
}

export function hasSubstitution(cmd: string): boolean {
  return /\$\(|`/.test(cmd)
}
