import type { Grammar } from './publish'

// A delimiter is a word: bare, quoted whole or in part, or with a backslash
// before a character. Quoting any of it keeps the body from being expanded, and
// the body ends on a line that says the word with the quotes taken out.
const HEREDOC_WORD = String.raw`(?:\\[\s\S]|"[^"]*"|'[^']*'|[^\s;&|<>()"'\\])+`

// Only the opener: the header line that follows is found by the caller, since
// a quote or a backslash can carry it over a newline. `<<<` is a here-string,
// which has no body.
const HEREDOC = new RegExp(String.raw`(?<!<)(<<-?[ \t]*(${HEREDOC_WORD}))`)

// In `$'…'` a backslash escapes the quote; in plain `'…'` it does not.
const ANSI_C_QUOTED = /\$'(?:[^'\\]|\\[\s\S])*'/

export const ANSI_C_STRING = new RegExp(ANSI_C_QUOTED.source, 'y')

const DOUBLE_QUOTED = /"(?:[^"\\]|\\[\s\S])*"/

const SINGLE_QUOTED = /'[^']*'/

const ESCAPED = /\\[\s\S]/

// `$$` is the process id. Read as a pair, its second `$` cannot open an ANSI-C
// string: `$$'a\'` is the id followed by a plain `'a\'`, which ends at the
// backslash.
const PROCESS_ID = /\$\$/

// A `#` opens a comment at the start of a word: after a blank or an operator.
// Only space, tab and newline are blanks to bash, so after a carriage return or
// a no-break space the `#` belongs to the word. The comment takes that
// character with it, so an escaped space cannot open one.
const BEFORE_COMMENT = /[ \t\n;&|()]/

// A `#` opens a comment at the start of a word. Not after a `)`: whether the
// `)` ends a word there, so the `#` begins a new one, depends on what it closes,
// which a parenthesis stack in `scrub` settles through COMMENT_GLUED.
const COMMENT = /(?:^|[ \t\n;&|(])#[^\n]*/

// A `#` glued to a `)`, matched short so a line of them that `scrub` reads as
// text — each `)` closing a word-gluing `$(…)`, `<(…)` or `>(…)` — stays linear.
// Where the `)` closes a subshell, an arithmetic command or a `case` pattern
// instead, `scrub` blanks the comment body itself.
const COMMENT_GLUED = /\)#/

export const COMMENT_OPENER = new RegExp(`^${BEFORE_COMMENT.source}#`)

// One pass, leftmost first: a quote opened before a `<<` hides it, a quote
// inside a heredoc body, a comment or the other kind of quote is not a quote,
// and an escaped quote or space outside quotes opens nothing.
export const OPAQUE = new RegExp(
  [HEREDOC, PROCESS_ID, ANSI_C_QUOTED, DOUBLE_QUOTED, SINGLE_QUOTED, ESCAPED, COMMENT, COMMENT_GLUED].map(r => r.source).join('|'),
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

// `xargs` is not one: it hands its stdin to the command as arguments, so what
// `xargs echo` or `xargs cat` prints is not the text on the command line.
const WRAPPERS = [
  `(?:sudo|doas)${wrapperOptions('sudoOptions', 'ugCDhpRrTtU', SUDO_LONG)}`,
  `env${wrapperOptions('envOptions', 'uCSP')}`,
  `exec${wrapperOptions('execOptions', 'a')}`,
  `time${wrapperOptions('timeOptions', 'fo')}`,
  `(?:command|builtin|nohup)${wrapperOptions('plainOptions', '')}`,
].join('|')

/**
 * Leading env assignments, wrappers and keywords that still leave the next
 * word the command. A wrapper's own options (`sudo -u root`, `env -i`) are
 * skipped. Embed it at most once per regex: it holds named groups.
 */
const COMMAND_PREFIX
  = `(?:(?:[A-Za-z_][A-Za-z0-9_]*=\\S*|${WRAPPERS}|then|do|else|elif|if|while|until|!)\\s+)*(?:[\\w./~-]*\\/)?`

// A brace opens or closes a group only as a word of its own. Inside a word
// (`find -exec … {} +`, `${X}`, `{a,b}`) it is text, and cutting the segment
// there would drop the arguments after it. So is the `}` that closes a `${`,
// even after a blank, as in `${X:- }`. An `&` is one only outside a redirect:
// `2>&1`, `>&2` and `&>file` belong to their command.
export const SEGMENT = /(?:[^\n;&|(){}`]|(?<=[<>])&|&(?=>)|(?<=[^\s;&|()`])[{}]|[{}](?=[^\s;&|()`])|\}(?<=\$\{[^}\n]*\}))+/g

const BACKQUOTED = /`(?:[^`\\]|\\[\s\S])*`/

// A character inside a parenthesis that opens nothing. A `$` before `(` or `'`
// is left out, so every text has one reading and an unclosed group fails in
// linear time instead of trying them all.
const IN_PARENTHESES = /[^()'"\\`$]|\$(?![('])/

const PARENTHESIZED = [IN_PARENTHESES, ANSI_C_QUOTED, DOUBLE_QUOTED, SINGLE_QUOTED, ESCAPED, BACKQUOTED].map(r => r.source).join('|')

function group(depth: number): string {
  return `\\((?:${PARENTHESIZED}${depth > 0 ? `|\\$?${group(depth - 1)}` : ''})*\\)`
}

// `$(…)` and `$((…))`, with up to three more levels of parentheses inside.
const SUBSTITUTION = `\\$${group(3)}`

/**
 * A shell word starting at the sticky index: quoted parts, escapes,
 * substitutions and plain characters run together until a blank, a newline or
 * an operator. Only space and tab are blanks to bash: a `\r` or a no-break space
 * is part of the word, so `> .env\r` writes a file that is not `.env`.
 */
export const WORD = new RegExp(
  `(?:${[PROCESS_ID, ANSI_C_QUOTED, DOUBLE_QUOTED, SINGLE_QUOTED, ESCAPED].map(r => r.source).join('|')}|${SUBSTITUTION}|${BACKQUOTED.source}|[^ \\t\\n"'|;&<>()\\\\])+`,
  'y',
)

/**
 * What can open a command word and expand to nothing, leaving the rest of the
 * word as the command name: `${X}git`, `$1git`, `"$X"git`, `$(true)git`. A
 * `$name` takes every name character, so `$Xgit` is one variable and nothing
 * is left of it.
 */
export const LEADING_EXPANSIONS = new RegExp(
  `^(?:\\$\\{[^}]*\\}|\\$(?:[A-Za-z_]\\w*|[1-9@*])|${SUBSTITUTION}|${BACKQUOTED.source}|(?="[^"]*[$\`])${DOUBLE_QUOTED.source})+`,
)

// Only the devices that cannot carry data off the machine. `/dev/tcp/…` and
// `/dev/udp/…` are bash network sockets, and `/dev/../x` is an ordinary file.
export const HARMLESS_DEVICE = /^\/dev\/(?:null|zero|full|stdout|stderr|tty)$/

// Ends a word: `>&2` duplicates a descriptor only as a whole word, and `>&2.txt`
// writes the file `2.txt`.
const WORD_END = String.raw`(?![^\s;&|<>()])`

// `>&2-` moves the descriptor instead of copying it; either way no file is named.
const DESCRIPTOR = String.raw`(?:\d+-?|-)${WORD_END}`

// `>`, `>>`, `>|`, `&>`, `>&file` with an optional fd; a duplicated or closed
// descriptor names no file. The fd is a whole run of digits: without the
// lookbehind a long run with no `>` after it is retried from each of its
// digits, which is quadratic.
export const REDIRECT = new RegExp(String.raw`(?<!\d)(?:\d+|&)?>(?:>|\||&(?!${DESCRIPTOR}))?(?!&${DESCRIPTOR})[ \t]*`, 'g')

// What a lone write may carry besides its targets: a duplicated descriptor, and
// a stream thrown away.
export const HARMLESS_REDIRECT = new RegExp(String.raw`\d?>&\d+-?${WORD_END}|\d>\s*/dev/null(?![^\s|<>])`, 'g')

export const TEE = new RegExp(`^\\s*${COMMAND_PREFIX}tee(?=\\s|$)`)

// A line continuation between words separates them like a blank.
export const BLANKS = /(?:[ \t]|\\\n)*/y

// What a command line is made of up to the newline that ends it: a quote, an
// escape or a comment each run over any newline inside, and the first newline
// outside them is the end. The newline is tried first, so a comment never
// starts on the one that ends the line.
export const LINE_PIECE = new RegExp(
  `\\n|${[PROCESS_ID, ANSI_C_QUOTED, DOUBLE_QUOTED, SINGLE_QUOTED, ESCAPED, COMMENT].map(r => r.source).join('|')}`,
  'g',
)

// After `<<` and its `-`, if any.
export const HEREDOC_DELIMITER = new RegExp(String.raw`[ \t]*(${HEREDOC_WORD})`, 'y')

export const REDIRECT_OPERATOR = /&?[<>]+[&|]?/y

export const FILE_READER = new RegExp(`^\\s*${COMMAND_PREFIX}(?:cat|head|tail)(?=\\s)`)

export const HEREDOC_INTO_CAT = new RegExp(`^\\s*${COMMAND_PREFIX}cat(?:\\s+\\d?>>?\\s*\\S+)?\\s+<<-?[ \\t]*(?<word>${HEREDOC_WORD})`)

// A `cat` that only forwards its stdin: no file operand but `-`, no heredoc and
// no redirect, so a script printed earlier reaches the next stage as written.
export const CAT_PASSTHROUGH = new RegExp(`^\\s*${COMMAND_PREFIX}cat(?:\\s+-)*\\s*$`)

// A heredoc or here-string the shell expands: `$(cat .env)` in its body is read.
// A quote or a backslash at the start of the delimiter keeps the body as it is.
export const EXPANDED_INLINE_INPUT = /<<<|<<-?[ \t]*[^\s'"\\]/

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

// A stretch that holds a substitution repeats the text of the ones inside it,
// so nesting multiplies what the passes over the stretches read: `a=$( ` a
// few thousand times is quadratic. A line whose stretches add up to more than
// this is blocked unread, since a hook that times out lets the call run.
export const MAX_SEGMENT_TEXT = 10 * MAX_COMMAND_LENGTH

// `bash -c "bash -c '…'"` is followed this many levels deep, then blocked.
export const MAX_SCRIPT_DEPTH = 3

// A double-quoted string ends at the next `"`, so a substitution in it that
// holds quoted words of its own is cut into as many pieces as it has quotes.
// Joining them again re-reads the text, so only this many are tried.
export const MAX_QUOTED_PARTS = 8

// A segment's words that name git, gh or a shell are tried as the command this
// many at a time, so a line made of them stays linear. It is far past the
// words one command line puts before its real command, and a line with more
// is blocked as unreadable.
export const MAX_COMMAND_CANDIDATES = 64

export const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash'])

// Commands that build the next command's arguments from their stdin.
export const ARGUMENTS_FROM_STDIN = new Set(['xargs', 'parallel'])

export const SHELL_COMMAND_OPTION = /^-[A-Zabd-z]*c[A-Za-z]*$/

export const SHELL_STDIN_OPTION = /^-[A-Za-rt-z]*s[A-Za-z]*$/

// A long option that takes a value of its own. So does each `o` and `O` of a
// short one, bundled or not: `-o pipefail`, `+O extglob`, `-eo pipefail`.
export const SHELL_VALUED_LONG_OPTION = /^--(?:rcfile|init-file)$/

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
  'stash': { short: 'm', long: [['message', 2, true]], files: [] },
}

const GH_BODY: Grammar = { short: 'aBbFHlmprtTR', long: [['body-file', 0, true], ['body', 0, true], ['title', 0, true], ['base', 0, true], ['head', 0, true], ['repo', 0, true]], files: ['F', 'body-file'] }

// Where `-a`, `-m` and `-r` choose a review verdict or a merge method they take
// no value, so reading one as valued would swallow the `-F file` after it.
const GH_REVIEW: Grammar = { ...GH_BODY, short: 'bFR' }
const GH_MERGE: Grammar = { ...GH_BODY, short: 'AbFtR' }
const GH_RELEASE: Grammar = { short: 'nFtR', long: [['notes-file', 0, true], ['notes', 0, true], ['title', 0, true], ['target', 0, true], ['repo', 0, true], ['discussion-category', 0, true], ['notes-start-tag', 0, true]], files: ['F', 'notes-file'] }

// Calls that publish only the text on their own line, which is scanned with
// it, or a substitution in it.
const GH_TEXT: Grammar = { short: 'R', long: [['repo', 0, true]], files: [] }

// The `gh pr` and `gh issue` subcommands that send text.
export const GH_WRITES = new Set(['create', 'edit', 'comment', 'review', 'merge', 'close', 'reopen', 'revert'])

// `gh pr new` runs `gh pr create`, and so on for issues, releases and gists.
export const GH_ALIASES: ReadonlyMap<string, string> = new Map([['new', 'create']])

export const GH_GRAMMARS: Readonly<Record<string, Grammar>> = {
  'pr': GH_BODY,
  'pr review': GH_REVIEW,
  'pr merge': GH_MERGE,
  'issue': GH_BODY,
  'release create': GH_RELEASE,
  'release edit': GH_RELEASE,
  'release upload': { short: 'R', long: [['repo', 0, true]], files: [] },
  'gist create': { short: 'dfR', long: [['desc', 0, true], ['filename', 0, true], ['repo', 0, true]], files: [] },
  'gist edit': { short: 'adfrR', long: [['add', 0, true], ['desc', 0, true], ['filename', 0, true], ['remove', 0, true], ['repo', 0, true]], files: ['a', 'add'] },
  // An Actions variable is plain text to anyone who can read the repository;
  // `gh secret set` is where a secret belongs, so it is left alone.
  'variable set': { short: 'befovrR', long: [['body', 0, true], ['env', 0, true], ['env-file', 0, true], ['org', 0, true], ['visibility', 0, true], ['repos', 0, true], ['repo', 0, true]], files: ['f', 'env-file'] },
  'workflow run': { short: 'FfrR', long: [['field', 0, true], ['raw-field', 0, true], ['ref', 0, true], ['json', 0, false], ['repo', 0, true]], files: [] },
  'label create': GH_TEXT,
  'label edit': GH_TEXT,
  'repo create': GH_TEXT,
  'repo edit': GH_TEXT,
  'project create': GH_TEXT,
  'project edit': GH_TEXT,
  'project item-create': GH_TEXT,
  'project item-edit': GH_TEXT,
  'api': { short: 'FfHXqtp', long: [['field', 0, true], ['raw-field', 0, true], ['header', 0, true], ['method', 0, true], ['input', 0, true], ['jq', 0, true], ['template', 0, true], ['preview', 0, true], ['hostname', 0, true], ['cache', 0, true]], files: ['input'] },
}

// `gh api -F key=@file` uploads the file as the field's value.
export const FIELD_FROM_FILE = /^[^=]*=@(.*)$/s

// Commands that read a local file and send it off the machine: HTTP uploads,
// copies to a remote host, and a raw network send.
export const UPLOADERS = new Set(['curl', 'wget', 'http', 'https', 'httpie', 'scp', 'rsync', 'sftp', 'nc', 'ncat', 'netcat'])

export const NETCATS = new Set(['nc', 'ncat', 'netcat'])

// curl sends a file as the request body (`-d @f`, `--data-binary @f`,
// `--data-urlencode name@f`), a form field (`-F k=@f` uploads it, `k=<f` reads
// the field from it) or an upload (`-T f`, `--upload-file f`).
export const CURL_GRAMMAR: Grammar = { short: 'dFT', long: [['data', 0, true], ['data-ascii', 0, true], ['data-binary', 0, true], ['data-raw', 0, true], ['data-urlencode', 0, true], ['form', 0, true], ['form-string', 0, true], ['upload-file', 0, true]], files: [] }

// A `-d`/`--data*` value whose leading `@` names a file; `@-` is stdin.
export const CURL_DATA_FILE = /^@(.*)$/s
// `--data-urlencode name@file` or `@file`; the `=` forms send literal text.
export const CURL_URLENCODE_FILE = /^[^=@]*@(.*)$/s
// `-F field=@file` or `field=<file`, with an optional `;type=` tail of metadata.
export const CURL_FORM_FILE = /^[^=]*=[@<]([^;]*)/

// wget reads the request body from a file named outright.
export const WGET_GRAMMAR: Grammar = { short: '', long: [['post-file', 0, true], ['body-file', 0, true]], files: ['post-file', 'body-file'] }

// httpie options that take a value, so their arguments are not read as request
// items; a file reaches it as `field@file`, `field=@file` or `field:=@file`.
export const HTTPIE_GRAMMAR: Grammar = { short: 'ao', long: [['auth', 0, true], ['auth-type', 0, true], ['output', 0, true], ['session', 0, true], ['session-read-only', 0, true]], files: [] }
export const HTTPIE_FILE = /^[\w.-]+(?::?=)?@(.*)$/s

// scp and rsync options that take a value, so a destination or a source is not
// read off one of them; only file-less flags are left to run together.
export const SCP_GRAMMAR: Grammar = { short: 'cDFiJloPSX', long: [], files: [] }
export const RSYNC_GRAMMAR: Grammar = { short: 'eTM', long: [['rsh', 0, true], ['files-from', 0, true]], files: [] }

// A remote scp or rsync endpoint: `host:path`, `user@host:path`, or an
// `rsync://` URL. A local path holds no colon before its first slash.
export const REMOTE_TARGET = /^[^/]*:/

// A substitution that only repeats text the command already holds.
export const CAT_HEREDOC = /[ \t]*cat[ \t]+<</y

export const LITERAL_ECHO = /[ \t]*(?:echo|printf)(?:[ \t][^\n$`()<>|;&\\'"]*)?\)/y

export const CLOSING_PAREN = /\s*\)/y

// `set -- $(cat .env)` fills the positional parameters as surely as `k=$(…)` fills a name.
// The shell drops a line continuation after the `$`, and zsh also reads `$=k`,
// `$~k`, `$^k` and a name with letters beyond ASCII.
export const EXPANDS_VARIABLE = /\$(?:\\\n)*[\w{@*=~^\u0080-\uFFFF]/

export const READS_INTO_VARIABLE = /(?:^|[\s;&|(])(?:read|mapfile|readarray)\s/

// A substitution that starts by reading a file: `$(cat .env)`, `$(< .env)`,
// `` `sed p .env` ``. A list of readers cannot be complete.
export const READING_SUBSTITUTION = /(?:\$\(|`)\s*(?:(?:sudo|command|env)\s+)*(?:(?:cat|head|tail|tac|sed|awk|grep|cut|tr|sort|base64|jq|xxd|od|strings|nl|rev|paste|less|more)(?=\s)|<(?![<(]))/

// What lands in the author or committer of a commit git makes, and so in the
// history anyone can read.
export const IDENTITY_CONFIG = /^(?:user|author|committer)\.(?:name|email)=/i

export const IDENTITY_ASSIGNMENT = /^(?:GIT_(?:AUTHOR|COMMITTER)_(?:NAME|EMAIL)|EMAIL)=/

// `export GIT_AUTHOR_NAME=$(cat .env)` on an earlier part of the line.
export const IDENTITY_FROM_READER = new RegExp(`(?:^|[\\s;&|(])${IDENTITY_ASSIGNMENT.source.slice(1)}["']?${READING_SUBSTITUTION.source}`)

// What `gh api` and `gh workflow run` send as the body of a request.
export const GH_FIELD_OPTIONS = ['F', 'f', 'field', 'raw-field', 'input', 'json']

// `f() …` or `function f …`.
export const DEFINES_FUNCTION = /(?:^|[\s;&|(){}])(?:function\s+[^\s;&|(){}]|[A-Z_][\w.:-]*\s*\(\s*\))/i
