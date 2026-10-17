import { MIN_LENGTH_TO_SHOW_PREFIX } from './constants'

export function redact(value: string): string {
  const shown = value.length >= MIN_LENGTH_TO_SHOW_PREFIX ? 4 : 0
  return `${value.slice(0, shown)}********`
}
