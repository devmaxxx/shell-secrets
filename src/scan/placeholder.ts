import { MARKER_WINDOW, PLACEHOLDER } from './constants'

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
