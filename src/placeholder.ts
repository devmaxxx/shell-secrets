const PLACEHOLDER
  = /x{4,}|\*{3,}|\.{3,}|<[^<>]*>|\{\{|example|placeholder|redacted|dummy|fake|sample|your[_-]?|changeme|replace[_-]?me|0{8,}|1234567/i

export const VARIABLE = /^\$(?:\{\w+\}|\w+)/

// A hand-typed stand-in announces itself up front. Deep in a long value a marker
// is chance — about one RSA-2048 key body in 200 spells one — and dismissing the
// value for it would wave a real key through.
const MARKER_WINDOW = 100

export function hasMarker(value: string): boolean {
  return PLACEHOLDER.test(value.slice(0, MARKER_WINDOW))
}

/**
 * A real token is random; a hand-typed stand-in repeats a few characters, and
 * a slug such as `sk-skeleton-loader-for-the-card` is lowercase words only.
 */
function looksRandom(value: string): boolean {
  const body = value.replace(/^[a-z]+[_-]/i, '')
  return (
    /[A-Z0-9]/.test(body)
    && new Set(body).size >= Math.min(12, Math.ceil(body.length / 3))
  )
}

export function isPlaceholder(value: string): boolean {
  return hasMarker(value) || !looksRandom(value)
}
