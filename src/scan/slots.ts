import type { CredentialSlot } from '../types'
import { ASSIGNS, AUTH_HEADER, FLAG_GAP, HEADER_GAP, MAX_SLOT_PREVIEW, NOT_SECRET_STAND_IN, NOT_SECRET_TAILS, SECRET_WORD, SLOT_NAME, SLOT_VALUE, URL_PASSWORD_END, URL_USER } from './constants'

/**
 * Every place `text` leaves for the user to type a secret into, ordered by
 * position: a secret-named variable, key or flag, or an `Authorization`
 * header, set to a stand-in (`<token>`, `your-key`, `xxxx`, `TOKEN_HERE`,
 * `[password]`), and the password of a URL (`postgres://app:<password>@db`).
 * A reference the shell expands (`$TOKEN`, `$(gh auth token)`) is no slot, and
 * a real-looking value is {@link findSecrets}'s to report. An empty or
 * non-string input returns `[]`.
 */
export function findCredentialSlots(text: string): CredentialSlot[] {
  return typeof text === 'string' ? slotsIn(text, text) : []
}

/**
 * The slots in `scanned`, a copy of `text` of the same length with some
 * stretches blanked; the previews come from `text`.
 */
export function slotsIn(scanned: string, text: string): CredentialSlot[] {
  const found = new Map<number, CredentialSlot>()
  const add = (from: number, name: string | null, slot: Span | null): void => {
    if (slot && !found.has(slot.start))
      found.set(slot.start, { ...slot, name, preview: text.slice(from, slot.end).slice(-MAX_SLOT_PREVIEW) })
  }
  for (const match of scanned.matchAll(SLOT_NAME)) {
    const name = match[0]
    const after = match.index + name.length
    // `$API_KEY` reads the variable; it is never what a value is written to.
    if (scanned[match.index - 1] === '$')
      continue
    const gap = namesSecret(name)
      ? stickyEnd(ASSIGNS, scanned, after) ?? (name.startsWith('-') ? stickyEnd(FLAG_GAP, scanned, after) : undefined)
      : AUTH_HEADER.test(name) ? stickyEnd(HEADER_GAP, scanned, after) : undefined
    if (gap !== undefined)
      add(match.index, name, valueAt(scanned, gap))
  }
  for (const match of scanned.matchAll(URL_USER)) {
    const slot = valueAt(scanned, match.index + match[0].length)
    if (slot && stickyEnd(URL_PASSWORD_END, scanned, slot.end) !== undefined)
      add(match.index + '://'.length, null, slot)
  }
  return [...found.values()].sort((a, b) => a.start - b.start)
}

// Where one word of a name ends and the next starts: at a `_` or `-`, or
// where a lowercase letter or digit meets a capital, as in `secretKey`.
function isWordBreak(name: string, at: number): boolean {
  const before = name[at - 1]
  const next = name[at]
  if (before === undefined || next === undefined || /[_-]/.test(before) || /[_-]/.test(next))
    return true
  return /[a-z\d]/.test(before) && /[A-Z]/.test(next)
}

function namesSecret(name: string): boolean {
  const lower = name.toLowerCase()
  if (NOT_SECRET_TAILS.some(tail => lower.endsWith(tail) && isWordBreak(name, name.length - tail.length)))
    return false
  for (const match of name.matchAll(SECRET_WORD)) {
    if (isWordBreak(name, match.index + match[0].length))
      return true
  }
  return false
}

function stickyEnd(pattern: RegExp, text: string, at: number): number | undefined {
  pattern.lastIndex = at
  return pattern.test(text) ? pattern.lastIndex : undefined
}

interface Span { start: number, end: number }

function valueAt(text: string, at: number): Span | null {
  SLOT_VALUE.lastIndex = at
  const match = SLOT_VALUE.exec(text)
  if (!match || NOT_SECRET_STAND_IN.test(match[0]))
    return null
  const end = at + match[0].length
  return { start: end - match[1]!.length, end }
}
