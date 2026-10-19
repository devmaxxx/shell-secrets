import type { Finding, Rule, ScanOptions } from '../types'
import { defaultRules } from '../rules'
import { findEncoded } from './base64'
import { isPlaceholder } from './placeholder'
import { redact } from './redact'

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

// Rules that share a `prepare` read the same subject, so it is made once per
// scan: a big file would otherwise pay for it once per rule, which put one
// 16 MiB file of `${` past the time the hook has.
type Subjects = Map<NonNullable<Rule['prepare']>, string>

function prepared(rule: Rule, text: string, subjects: Subjects): string {
  if (!rule.prepare) {
    return text
  }
  let subject = subjects.get(rule.prepare)
  if (subject === undefined) {
    subject = rule.prepare(text)
    if (subject.length !== text.length) {
      throw new Error(`shell-secrets: rule "${rule.id}" prepare() changed the text's length, so offsets would be wrong`)
    }
    subjects.set(rule.prepare, subject)
  }
  return subject
}

function scanRule(rule: Rule, text: string, subjects: Subjects): Finding[] {
  const subject = prepared(rule, text, subjects)
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
  const subjects: Subjects = new Map()
  const found = rules.filter(rule => !rule.fallback).flatMap(rule => scanRule(rule, text, subjects))
  const keep = (fresh: Finding[]): void => {
    const overlaps = overlapIndex(found)
    // One push per finding: spreading a six-figure array overflows the stack.
    for (const f of fresh) {
      if (!overlaps(f))
        found.push(f)
    }
  }
  keep(findEncoded(text, decoded => findSecrets(decoded, { rules })))
  for (const rule of rules.filter(rule => rule.fallback))
    keep(scanRule(rule, text, subjects))
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

/**
 * The secrets `after` holds that `before` did not already carry — for an edit
 * or a diff, where keeping an existing secret as context writes nothing new.
 * Offsets refer to `after`.
 */
export function findNewSecrets(before: string, after: string, options: ScanOptions = {}): Finding[] {
  const known = typeof before === 'string' ? before : ''
  return findSecrets(after, options).filter(f => !known.includes(after.slice(f.start, f.end)))
}
