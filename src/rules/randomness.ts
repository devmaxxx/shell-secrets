import { CLASSES, COMMON_BIGRAMS, MAX_JUDGED_LENGTH } from './constants'

function choose(n: number, k: number): number {
  let result = 1
  for (let i = 1; i <= k; i++)
    result = result * (n - k + i) / i
  return result
}

/** The probability of a count at least as far from `n * p` as `x`, on its side. */
function binomialTail(n: number, x: number, p: number): number {
  const [from, to] = x < n * p ? [0, x] : [x, n]
  let total = 0
  for (let i = from; i <= to; i++)
    total += choose(n, i) * p ** i * (1 - p) ** (n - i)
  return total
}

// The ways to spread n positions over exactly k symbols, each used at least
// once: a Stirling number of the second kind. Rows are kept, since every
// judged value of length n reads from row n.
const STIRLING: number[][] = [[1]]

function partitions(n: number, k: number): number {
  for (let i = STIRLING.length; i <= n; i++) {
    const last = STIRLING[i - 1]!
    STIRLING.push(Array.from({ length: i + 1 }, (_, j) => j === 0 ? 0 : j * (last[j] ?? 0) + (last[j - 1] ?? 0)))
  }
  return STIRLING[n]![k] ?? 0
}

function pDistinct(value: string, base: number): number {
  const distinct = new Set(value).size
  let outcomes = 0
  for (let k = 1; k <= distinct; k++) {
    let symbols = 1
    for (let i = 0; i < k; i++)
      symbols *= base - i
    outcomes += symbols * partitions(value.length, k)
  }
  return outcomes / base ** value.length
}

function count(value: string, test: RegExp): number {
  return [...value].filter(c => test.test(c)).length
}

/**
 * How likely `value` is to show what it shows if it were random: few distinct
 * characters, a lopsided share of digits or of one case, and pairs common in
 * words and identifiers. Plain Shannon entropy cannot tell a 20-character
 * camelCase name from a key; these counts can. Ported from ripsecrets.
 */
function pRandom(value: string): number {
  const base = /^[0-9a-f]+$/i.test(value) ? 16 : /^[0-9A-Z]+$/.test(value) ? 36 : 64
  const classes = CLASSES.slice(0, base === 16 ? 1 : base === 36 ? 2 : 3)
  const pClass = Math.min(...classes.map(([test, size]) => binomialTail(value.length, count(value, test), size / base)))
  let p = pDistinct(value, base) * pClass
  if (base === 64) {
    let pairs = 0
    for (let i = 0; i + 1 < value.length; i++) {
      if (COMMON_BIGRAMS.has(value.slice(i, i + 2)))
        pairs++
    }
    p *= binomialTail(value.length, pairs, COMMON_BIGRAMS.size / 4096)
  }
  return p
}

/** Whether `value` reads as machine-generated rather than a word or a name. */
export function isRandom(value: string): boolean {
  if (value.length > MAX_JUDGED_LENGTH)
    return true
  const p = pRandom(value)
  return p >= 1e-5 && (/\d/.test(value) || p >= 1e-4)
}
