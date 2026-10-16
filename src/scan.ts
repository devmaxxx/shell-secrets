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
    throw new Error(`secret-sniffer: rule "${rule.id}" prepare() changed the text's length, so offsets would be wrong`)
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
  return rules
    .flatMap(rule => scanRule(rule, text))
    .sort((a, b) => a.start - b.start)
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
