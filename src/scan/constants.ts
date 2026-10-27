export const PLACEHOLDER
  = /x{4,}|\*{3,}|\.{3,}|<[^<>]*>|\{\{|example|placeholder|redacted|dummy|fake|sample|your[_-]?|changeme|replace[_-]?me|0{8,}|1234567/i

export const VARIABLE = /^\$(?:\{\w+\}|\w+)/

// A hand-typed stand-in announces itself up front. Deep in a long value a marker
// is chance — about one RSA-2048 key body in 200 spells one — and dismissing the
// value for it would wave a real key through.
export const MARKER_WINDOW = 100

// Below this a few leading characters are too large a share of the secret to show.
export const MIN_LENGTH_TO_SHOW_PREFIX = 20

// A `=` is padding, which only ever ends a blob, so one just before a run does
// not make the run the tail of a longer blob: `KEY=blob` and `?d=blob` are
// where encoded values sit.
export const BASE64_BLOB = /(?<![\w+/-])[\w+/-]{32,}={0,2}(?![\w+/=-])/g

export const PRINTABLE = /^[\t\n\r\x20-\x7E]*$/

// What a person is meant to overwrite by hand. `$NAME`, `${NAME}` and `$(cmd)`
// are references the shell expands, so they never count. An angle-bracketed
// stand-in neither starts nor ends with a blank, so the redirections in
// `cmd < in > out` are not one; a bracketed one is letters only, so a regex
// class such as `[a-z0-9]` or `[A-Z_]` is not one either.
export const SLOT_VALUE = /["']?(<[^\s<>][^<>\n]*(?<!\s)>|\[[a-z][a-z_ ]*[a-z]\]|your[_-][\w-]*|paste[\w-]*|x{4,}|\w*_here(?![\w-])|changeme|replace[_-]?me)/iy

// Every slot starts from a name, found as one maximal run of these, so no two
// candidates share the characters a pattern scans: the search stays linear
// on any input.
export const SLOT_NAME = /[\w-]+/g
export const SECRET_WORD = /token|secret|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|credentials?/i
export const AUTH_HEADER = /authorization$/i

// The scheme after the header name is optional, and blanks follow it only
// when it is there: two optional runs of blanks in a row would try every split
// of a long one.
export const ASSIGNS = /["']?\s*[:=]\s*/y
export const FLAG_GAP = /\s+/y
export const HEADER_GAP = /\s*:\s*(?:(?:bearer|basic|token)\s+)?/iy

// `scheme://user:<password>@`: the user part stops at the characters that
// end it, so it is scanned once.
export const URL_USER = /:\/\/([^\s:/@]+):/g
export const URL_PASSWORD_END = /@/y

export const MAX_SLOT_PREVIEW = 80
