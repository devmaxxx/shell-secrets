import type { Grammar } from './publish'

// Group 4 is the rest of the header line, kept because a `&& gh …` can live there.
// `<<<` is a here-string, which has no body.
const HEREDOC = /(?<!<)(<<-?\s*(["']?)(\w+)\b\2)([^\n]*)\n/

// In `$'…'` a backslash escapes the quote; in plain `'…'` it does not.
const ANSI_C_QUOTED = /\$'(?:[^'\\]|\\[\s\S])*'/

export const ANSI_C_STRING = new RegExp(ANSI_C_QUOTED.source, 'y')

const DOUBLE_QUOTED = /"(?:[^"\\]|\\[\s\S])*"/

const SINGLE_QUOTED = /'[^']*'/

const ESCAPED = /\\[\s\S]/

// A `#` opens a comment at the start of a word: after a blank or an operator.
// It takes that character with it, so an escaped space cannot open one.
const COMMENT = /(?:^|[\s;&|()])#[^\n]*/

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

// A brace opens or closes a group only as a word of its own. Inside a word
// (`find -exec … {} +`, `${X}`, `{a,b}`) it is text, and cutting the segment
// there would drop the arguments after it.
export const SEGMENT = /(?:[^\n;&|(){}`]|(?<=[^\s;&|()`])[{}]|[{}](?=[^\s;&|()`]))+/g

/**
 * A shell word starting at the sticky index: quoted parts, escapes and plain
 * characters run together until a blank, a newline or an operator. Only space
 * and tab are blanks to bash: a `\r` or a no-break space is part of the word,
 * so `> .env\r` writes a file that is not `.env`.
 */
export const WORD = new RegExp(
  `(?:${[ANSI_C_QUOTED, DOUBLE_QUOTED, SINGLE_QUOTED, ESCAPED].map(r => r.source).join('|')}|[^ \\t\\n"'|;&<>()\\\\])+`,
  'y',
)

// Only the devices that cannot carry data off the machine. `/dev/tcp/…` and
// `/dev/udp/…` are bash network sockets, and `/dev/../x` is an ordinary file.
export const HARMLESS_DEVICE = /^\/dev\/(?:null|zero|full|stdout|stderr|tty)$/

// `>`, `>>`, `>|`, `&>`, `>&file` with an optional fd; `>&2` and `>&-` only
// duplicate or close a descriptor and name no file.
export const REDIRECT = /(?:\d+|&)?>(?:>|\||&(?![\d-]))?(?!&[\d-])[ \t]*/g

export const TEE = new RegExp(`^\\s*${COMMAND_PREFIX}tee(?=\\s|$)`)

// A line continuation between words separates them like a blank.
export const BLANKS = /(?:[ \t]|\\\n)*/y

// After `<<`: an optional `-`, then the delimiter, bare, quoted or escaped.
export const HEREDOC_DELIMITER = /(-?)[ \t]*(["']?)\\?(\w+)\2/y

export const REDIRECT_OPERATOR = /[<>]+[&|]?/y

export const FILE_READER = new RegExp(`^\\s*${COMMAND_PREFIX}(?:cat|head|tail)(?=\\s)`)

export const HEREDOC_INTO_CAT = new RegExp(`^\\s*${COMMAND_PREFIX}cat(?:\\s+\\d?>>?\\s*\\S+)?\\s+<<-?\\s*(?<quote>['"]?)\\w+\\k<quote>`)

// A heredoc or here-string the shell expands: `$(cat .env)` in its body is read.
export const EXPANDED_INLINE_INPUT = /<<<|<<-?\s*\w/

export const LITERAL_STDIN = new RegExp(`^\\s*${COMMAND_PREFIX}(?:echo|printf)(?=\\s|$)`)

export const CHANGES_DIRECTORY = new RegExp(`^\\s*${COMMAND_PREFIX}(?:cd|pushd|popd)(?=\\s|$)`)

export const INPUT_REDIRECT = /(?<![<\d])\d?<(?![<(&])[ \t]*/g

// `head -n 5` and `tail -n +2` count lines; the count is not a file.
export const LINE_COUNT = /^[+-]?\d+[bkm]?$/i

// `&` and `;` are left out of the boundary: unspaced, they are far more often a
// URI's `&password=` or a JDBC `;password=` than a shell operator.
export const ASSIGNMENT_BEFORE = /(?:^|[\s("'])([A-Z_]\w*)=["']?$/i

export const ASSIGNMENT_LOOKBEHIND = 256

// A command line longer than this is not parsed: its regexes would outlast the
// hook's time budget, and a hook that times out lets the call run.
export const MAX_COMMAND_LENGTH = 100_000

// `bash -c "bash -c '…'"` is followed this many levels deep, then blocked.
export const MAX_SCRIPT_DEPTH = 3

export const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash'])

// Commands that build the next command's arguments from their stdin.
export const ARGUMENTS_FROM_STDIN = new Set(['xargs', 'parallel'])

export const SHELL_COMMAND_OPTION = /^-[A-Zabd-z]*c[A-Za-z]*$/

export const SHELL_STDIN_OPTION = /^-[A-Za-rt-z]*s[A-Za-z]*$/

export const SHELL_VALUED_OPTION = /^[-+][oO]$|^--(?:rcfile|init-file)$/

// Programs that run a command handed to them as one string, through a shell
// or by splitting it into words.
export const COMMAND_RUNNERS = new Set(['env', 'su', 'runuser', 'script', 'flock', 'watch'])

export const RUNNER_COMMAND_OPTION = /^--(?:session-)?command(?:=|$)/

// `env -S` and `--split-string`, after any flags bundled with it.
export const SPLIT_STRING_OPTION = /^(?:-[0iv]*S|--split-string(?:=|$))/

export const ENV_VALUED_OPTION = /^-[0iv]*[uCP]$|^--(?:unset|chdir)$/

export const WATCH_VALUED_OPTION = /^-[A-Za-z]*[nq]$|^--(?:interval|equexit)$/

// `su -`, `su -l` and `su --login` start a login shell in the user's home.
export const LOGIN_OPTION = /^-$|^-[A-Za-km-z]*l[A-Za-z]*$|^--login$/

// Global options that point git at another repository or work tree.
export const GIT_PLACE_OPTION = /^(?:-C|--git-dir|--work-tree)(?:=|$)/

export const GIT_VALUED_GLOBAL = /^(?:-[Cc]|--(?:git-dir|work-tree|namespace|super-prefix|config-env|attr-source|shallow-file))$/

/**
 * The git and gh subcommands that publish content, and the options that
 * matter to finding it. Git takes any unique prefix of a long option, so each
 * long option carries the shortest prefix that still names it; gh takes only
 * the full name (0). Options not listed are read as flags without a value.
 * `files` names the options whose value is a file published as it is.
 */
export const GIT_GRAMMARS: Readonly<Record<string, Grammar>> = {
  'add': { short: '', long: [['force', 1, false], ['all', 1, false], ['pathspec-from-file', 10, true], ['chmod', 2, true]], files: [] },
  'commit': { short: 'mCctF', long: [['file', 3, true], ['template', 2, true], ['message', 2, true], ['author', 2, true], ['date', 2, true], ['reuse-message', 3, true], ['reedit-message', 3, true], ['fixup', 3, true], ['squash', 2, true], ['trailer', 2, true], ['cleanup', 2, true]], files: ['F', 'file', 't', 'template'] },
  'tag': { short: 'mFu', long: [['file', 2, true], ['message', 2, true], ['local-user', 2, true], ['cleanup', 2, true]], files: ['F', 'file'] },
  'notes': { short: 'mFCc', long: [['file', 2, true], ['message', 2, true], ['reuse-message', 3, true], ['reedit-message', 3, true]], files: ['F', 'file'] },
  'merge': { short: 'mFsX', long: [['file', 2, true], ['message', 2, true], ['strategy', 8, true], ['strategy-option', 10, true]], files: ['F', 'file'] },
  'update-index': { short: '', long: [['add', 2, false], ['stdin', 2, false], ['index-info', 2, false], ['cacheinfo', 2, true], ['chmod', 3, true]], files: [] },
  'hash-object': { short: 't', long: [['stdin', 5, false], ['stdin-paths', 7, false], ['type', 2, true], ['path', 2, true]], files: [] },
}

const GH_BODY: Grammar = { short: 'aBbFHlmprtTR', long: [['body-file', 0, true], ['body', 0, true], ['title', 0, true], ['base', 0, true], ['head', 0, true], ['repo', 0, true]], files: ['F', 'body-file'] }
const GH_RELEASE: Grammar = { short: 'nFtR', long: [['notes-file', 0, true], ['notes', 0, true], ['title', 0, true], ['target', 0, true], ['repo', 0, true], ['discussion-category', 0, true], ['notes-start-tag', 0, true]], files: ['F', 'notes-file'] }

// The `gh pr` and `gh issue` subcommands that send text.
export const GH_WRITES = new Set(['create', 'edit', 'comment', 'review', 'merge', 'close'])

export const GH_GRAMMARS: Readonly<Record<string, Grammar>> = {
  'pr': GH_BODY,
  'issue': GH_BODY,
  'release create': GH_RELEASE,
  'release edit': GH_RELEASE,
  'release upload': { short: 'R', long: [['repo', 0, true]], files: [] },
  'gist create': { short: 'df', long: [['desc', 0, true], ['filename', 0, true]], files: [] },
  'gist edit': { short: 'adfr', long: [['add', 0, true], ['desc', 0, true], ['filename', 0, true], ['remove', 0, true]], files: ['a', 'add'] },
  'api': { short: 'FfHXqtp', long: [['field', 0, true], ['raw-field', 0, true], ['header', 0, true], ['method', 0, true], ['input', 0, true], ['jq', 0, true], ['template', 0, true], ['preview', 0, true], ['hostname', 0, true], ['cache', 0, true]], files: ['input'] },
}

// `gh api -F key=@file` uploads the file as the field's value.
export const FIELD_FROM_FILE = /^[^=]*=@(.*)$/s

// A substitution that only repeats text the command already holds.
export const CAT_HEREDOC = /[ \t]*cat[ \t]+<</y

export const LITERAL_ECHO = /[ \t]*(?:echo|printf)(?:[ \t][^\n$`()<>|;&\\'"]*)?\)/y

export const CLOSING_PAREN = /\s*\)/y

// `set -- $(cat .env)` fills the positional parameters as surely as `k=$(…)` fills a name.
export const EXPANDS_VARIABLE = /\$[\w{@*]/

export const READS_INTO_VARIABLE = /(?:^|[\s;&|(])(?:read|mapfile|readarray)\s/

// `f() …` or `function f …`.
export const DEFINES_FUNCTION = /(?:^|[\s;&|(){}])(?:function\s+[^\s;&|(){}]|[A-Z_][\w.:-]*\s*\(\s*\))/i
