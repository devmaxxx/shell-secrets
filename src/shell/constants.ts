// Group 4 is the rest of the header line, kept because a `&& gh …` can live there.
// `<<<` is a here-string, which has no body.
const HEREDOC = /(?<!<)(<<-?\s*(["']?)(\w+)\b\2)([^\n]*)\n/

// In `$'…'` a backslash escapes the quote; in plain `'…'` it does not.
const ANSI_C_QUOTED = /\$'(?:[^'\\]|\\[\s\S])*'/

const DOUBLE_QUOTED = /"(?:[^"\\]|\\[\s\S])*"/

const SINGLE_QUOTED = /'[^']*'/

const ESCAPED = /\\[\s\S]/

// Takes the blank before the `#` with it, so an escaped space cannot open one.
const COMMENT = /(?:^|\s)#[^\n]*/

// One pass, leftmost first: a quote opened before a `<<` hides it, a quote
// inside a heredoc body, a comment or the other kind of quote is not a quote,
// and an escaped quote or space outside quotes opens nothing.
export const OPAQUE = new RegExp(
  [HEREDOC, ANSI_C_QUOTED, DOUBLE_QUOTED, SINGLE_QUOTED, ESCAPED, COMMENT].map(r => r.source).join('|'),
  'g',
)

const SUDO_LONG = 'user|group|host|prompt|role|type|chroot|chdir|other-user|command-timeout|close-from'

// The lookahead and back-reference make each option run atomic. Backtracking
// into it would let every word be an option's value or the next wrapper, and a
// run like `sudo -u sudo -u …` would take exponential time to reject.
//
// `valued` lists the short options that take a separate value, per wrapper: a
// flag like `sudo -E` or `command -p` stands alone, and counting it as valued
// would swallow the command that follows. A bundle takes its value from its
// last letter (`sudo -iu root`).
function wrapperOptions(id: string, valued: string, longValued = ''): string {
  const short = valued ? `-[A-Za-z]*[${valued}]\\s+[^-\\s]\\S*|` : ''
  const long = longValued ? `--(?:${longValued})\\s+[^-\\s]\\S*|` : ''
  return `(?=(?<${id}>(?:\\s+(?:${short}${long}-\\S+))*))\\k<${id}>`
}

const WRAPPERS = [
  `(?:sudo|doas)${wrapperOptions('sudoOptions', 'ugCDhpRrTtU', SUDO_LONG)}`,
  `env${wrapperOptions('envOptions', 'uCSP')}`,
  `xargs${wrapperOptions('xargsOptions', 'nIdLsEPa')}`,
  `exec${wrapperOptions('execOptions', 'a')}`,
  `time${wrapperOptions('timeOptions', 'fo')}`,
  `(?:command|builtin|nohup)${wrapperOptions('plainOptions', '')}`,
].join('|')

/**
 * Leading env assignments, wrappers and keywords that still leave the next
 * word the command. A wrapper's own options (`sudo -u root`, `env -i`,
 * `xargs -n 1`) are skipped. Embed it at most once per regex: it holds named
 * groups.
 */
const COMMAND_PREFIX
  = `(?:(?:[A-Za-z_][A-Za-z0-9_]*=\\S*|${WRAPPERS}|then|do|else|elif|if|while|until|!)\\s+)*(?:[\\w./~-]*\\/)?`

export const SEGMENT = /[^\n;&|(){}`]+/g

/**
 * A shell word starting at the sticky index: quoted parts, escapes and plain
 * characters run together until whitespace or an operator.
 */
export const WORD = new RegExp(
  `(?:${[ANSI_C_QUOTED, DOUBLE_QUOTED, SINGLE_QUOTED, ESCAPED].map(r => r.source).join('|')}|[^\\s"'|;&<>()\\\\])+`,
  'y',
)

// Only the devices that cannot carry data off the machine. `/dev/tcp/…` and
// `/dev/udp/…` are bash network sockets, and `/dev/../x` is an ordinary file.
export const HARMLESS_DEVICE = /^\/dev\/(?:null|zero|full|stdout|stderr|tty)$/

// `>`, `>>`, `>|`, `&>`, `>&file` with an optional fd; `>&2` and `>&-` only
// duplicate or close a descriptor and name no file.
export const REDIRECT = /(?:\d+|&)?>(?:>|\||&(?![\d-]))?(?!&[\d-])\s*/g

export const TEE = new RegExp(`^\\s*${COMMAND_PREFIX}tee(?=\\s|$)`)

export const BLANKS = /[ \t]*/y

export const REDIRECT_OPERATOR = /[<>]+[&|]?/y

// Global options such as `-C dir` or `--no-pager` may sit between `git` and
// its subcommand. `gh api -F` is a form field and `git grep -F` a fixed
// string, so only the subcommands that publish a file are read.
export const PUBLISHES_FILE = new RegExp(
  `^\\s*${COMMAND_PREFIX}(?:git(?:\\s+-\\S+(?:\\s+[^-\\s]\\S*)?)*?\\s+(?:commit|tag|notes|merge)|gh\\s+(?:pr|issue|release))(?![\\w-])`,
)

// `-F` may be bundled (`-aF msg`) or glued to its value (`-Fmsg`). After a
// letter that takes a value (`-mF` is the message "F") the rest is that value.
export const MESSAGE_FILE_FLAG = /(?<=^|\s)(?:-(?:(?![mCctuS])[A-Za-z])*?F|--(?:file|body-file|notes-file)(?=[=\s]))=?\s*/g

export const FORCED_ADD = new RegExp(`^\\s*${COMMAND_PREFIX}git(?:\\s+-\\S+(?:\\s+[^-\\s]\\S*)?)*?\\s+add(?=\\s)`)

// `-A` with no pathspec stages the whole tree; `-u` touches tracked files only,
// which .gitignore never kept out. A pathspec file names files this cannot see.
export const ADDS_ALL = /^(?:-[B-Za-z]*A[A-Za-z]*|--all)$/

export const PATHSPEC_FILE = /^--pathspec-from-file(?:=|$)/

export const GIT_DIR_OPTION = /\sgit\s(?:.*\s)?-C\s/

export const FILE_READER = new RegExp(`^\\s*${COMMAND_PREFIX}(?:cat|head|tail)(?=\\s)`)

export const HEREDOC_INTO_CAT = new RegExp(`^\\s*${COMMAND_PREFIX}cat(?:\\s+\\d?>>?\\s*\\S+)?\\s+<<-?\\s*(?<quote>['"]?)\\w+\\k<quote>`)

// A heredoc or here-string the shell expands: `$(cat .env)` in its body is read.
export const EXPANDED_INLINE_INPUT = /<<<|<<-?\s*\w/

export const LITERAL_STDIN = new RegExp(`^\\s*${COMMAND_PREFIX}(?:echo|printf)(?=\\s|$)`)

export const CHANGES_DIRECTORY = new RegExp(`^\\s*${COMMAND_PREFIX}(?:cd|pushd|popd)(?=\\s|$)`)

export const INPUT_REDIRECT = /(?<![<\d])\d?<(?![<(&])\s*/g

// `head -n 5` and `tail -n +2` count lines; the count is not a file.
export const LINE_COUNT = /^[+-]?\d+[bkm]?$/i

// `&` and `;` are left out of the boundary: unspaced, they are far more often a
// URI's `&password=` or a JDBC `;password=` than a shell operator.
export const ASSIGNMENT_BEFORE = /(?:^|[\s("'])([A-Z_]\w*)=["']?$/i

export const ASSIGNMENT_LOOKBEHIND = 256
