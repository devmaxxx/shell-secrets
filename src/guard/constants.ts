// The path is whatever follows the marker: a lone carriage return, U+2028 or
// U+2029 is part of it, as it is to Codex, though `.` would stop at one.
export const PATCH_FILE = /^\*\*\* (Add File|Update File|Move to): (.+)$/s

// The characters Rust's `str::trim`, which Codex cuts a patch line with, strips.
// JavaScript's `trim` differs: it strips U+FEFF and keeps U+0085.
export const PATCH_BLANK = /[\t\n\v\f\r \u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/

// The paths one tool call may make the hook ask git about. A real call names a
// handful; more than this is a call padded to outlast the hook's timeout.
export const MAX_LOOKUPS = 32
