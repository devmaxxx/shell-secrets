import type { Finding, Rule, ScanOptions } from './types'
import { isPlaceholder } from './placeholder'
import { defaultRules } from './rules'

const runnable = new WeakMap<RegExp, RegExp>()

/** The rule's pattern with `g` and `d` added: every match, with group offsets. */
function runnablePattern(pattern: RegExp): RegExp {
  let compiled = runnable.get(pattern)
  if (!compiled) {
    const flags = new Set([...pattern.flags, 'g', 'd'])
    compiled = new RegExp(pattern.source, [...flags].join(''))
    runnable.set(pattern, compiled)
  }
  return compiled
}

function prepared(rule: Rule, text: string): string {
  if (!rule.prepare) {
    return text
  }
  const subject = rule.prepare(text)
  if (subject.length !== text.length) {
    throw new Error(`shell-secrets: rule "${rule.id}" prepare() changed the text's length, so offsets would be wrong`)
  }
  return subject
}

// Below this a few leading characters are too large a share of the secret to show.
const MIN_LENGTH_TO_SHOW_PREFIX = 20

function redact(value: string): string {
  const shown = value.length >= MIN_LENGTH_TO_SHOW_PREFIX ? 4 : 0
  return `${value.slice(0, shown)}********`
}

function scanRule(rule: Rule, text: string): Finding[] {
  const subject = prepared(rule, text)
  const group = rule.secretGroup ?? 0
  const found: Finding[] = []
  for (const match of subject.matchAll(runnablePattern(rule.pattern))) {
    const span = match.indices?.[group]
    if (!span || rule.ignore?.(match)) {
      continue
    }
    const [start, end] = span
    if ((rule.placeholders ?? true) && isPlaceholder(subject.slice(start, end))) {
      continue
    }
    found.push({
      ruleId: rule.id,
      name: rule.name,
      env: rule.env,
      start,
      end,
      preview: redact(text.slice(start, end)),
    })
  }
  return found
}

/**
 * Every live-looking secret in `text`, ordered by position.
 *
 * Placeholders (`ghp_xxxx…`, `<token>`, `example`, low-variety stand-ins),
 * variable references (`${DB_PASSWORD}`) and local development credentials
 * (`postgres:postgres@localhost`) are not reported.
 *
 * @example
 * ```ts
 * for (const f of findSecrets(source)) {
 *   console.warn(`${f.name} at ${f.start}: ${f.preview} — use $${f.env}`)
 * }
 * ```
 */
export function findSecrets(text: string, options: ScanOptions = {}): Finding[] {
  if (typeof text !== 'string' || text === '') {
    return []
  }
  const rules = options.rules ?? defaultRules
  const found = rules.filter(rule => !rule.fallback).flatMap(rule => scanRule(rule, text))
  const keep = (fresh: Finding[]): void => {
    const overlaps = overlapIndex(found)
    // One push per finding: spreading a six-figure array overflows the stack.
    for (const f of fresh) {
      if (!overlaps(f))
        found.push(f)
    }
  }
  keep(findEncoded(text, rules))
  for (const rule of rules.filter(rule => rule.fallback))
    keep(scanRule(rule, text))
  return found.sort((a, b) => a.start - b.start)
}

// Kept findings sorted by start, with the furthest end reached so far: a
// finding overlaps one of them when the last kept finding to start before its
// end reaches past its start. Linear checks against every kept finding go
// quadratic on a file with a finding on each of 200k lines.
function overlapIndex(kept: readonly Finding[]): (f: Finding) => boolean {
  const sorted = [...kept].sort((a, b) => a.start - b.start)
  const reach: number[] = []
  for (const [i, f] of sorted.entries())
    reach.push(Math.max(f.end, reach[i - 1] ?? 0))
  return (f) => {
    let lo = 0
    let hi = sorted.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (sorted[mid]!.start < f.end)
        lo = mid + 1
      else
        hi = mid
    }
    return lo > 0 && reach[lo - 1]! > f.start
  }
}

const BASE64_BLOB = /(?<![\w+/=-])[\w+/-]{32,}={0,2}(?![\w+/=-])/g
const PRINTABLE = /^[\t\n\r\x20-\x7E]*$/

function decodeBase64(blob: string): string | null {
  try {
    const decoded = atob(blob.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, ''))
    return PRINTABLE.test(decoded) ? decoded : null
  }
  catch {
    return null
  }
}

// A Kubernetes Secret, a `base64 -d` pipeline or a Basic credential carries the
// secret encoded. A blob that decodes to binary (a key body, a hash) is passed
// over; one that decodes to text is scanned like any text, nested encodings
// included, and each level is three quarters the size of the one above. The
// finding spans the encoded text.
function findEncoded(text: string, rules: readonly Rule[]): Finding[] {
  const found: Finding[] = []
  for (const match of text.matchAll(BASE64_BLOB)) {
    const decoded = decodeBase64(match[0])
    const inner = decoded === null ? undefined : findSecrets(decoded, { rules })[0]
    if (!decoded || !inner)
      continue
    found.push({
      ...inner,
      name: `${inner.name}, base64-encoded`,
      start: match.index,
      end: match.index + match[0].length,
      preview: redact(decoded.slice(inner.start, inner.end)),
    })
  }
  return found
}

/**
 * The secrets `after` holds that `before` did not already carry — for an edit
 * or a diff, where keeping an existing secret as context writes nothing new.
 * Offsets refer to `after`.
 */
export function findNewSecrets(before: string, after: string, options: ScanOptions = {}): Finding[] {
  const known = typeof before === 'string' ? before : ''
  return findSecrets(after, options).filter(f => !known.includes(after.slice(f.start, f.end)))
}
