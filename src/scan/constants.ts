export const PLACEHOLDER
  = /x{4,}|\*{3,}|\.{3,}|<[^<>]*>|\{\{|example|placeholder|redacted|dummy|fake|sample|your[_-]?|changeme|replace[_-]?me|0{8,}|1234567/i

export const VARIABLE = /^\$(?:\{\w+\}|\w+)/

// A hand-typed stand-in announces itself up front. Deep in a long value a marker
// is chance — about one RSA-2048 key body in 200 spells one — and dismissing the
// value for it would wave a real key through.
export const MARKER_WINDOW = 100

// Below this a few leading characters are too large a share of the secret to show.
export const MIN_LENGTH_TO_SHOW_PREFIX = 20

export const BASE64_BLOB = /(?<![\w+/=-])[\w+/-]{32,}={0,2}(?![\w+/=-])/g

export const PRINTABLE = /^[\t\n\r\x20-\x7E]*$/
