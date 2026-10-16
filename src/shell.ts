// $3 is the rest of the header line, kept because a `&& gh …` can live there.
const HEREDOC = /<<-?\s*(["']?)(\w+)\b\1([^\n]*)\n(?:[\s\S]*?\n)?[ \t]*\2\b/g
const DOUBLE_QUOTED = /"(?:[^"\\]|\\[\s\S])*"/g
const SINGLE_QUOTED = /'[^']*'/g
const COMMENT = /(^|\s)#[^\n]*/g
const LINE_CONTINUATION = /\\\n/g

const SEGMENT_BREAK = /[\n;&|(){}`]+/

/** Leading env assignments and wrappers that still leave the next word the command. */
const COMMAND_PREFIX
  = '(?:[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+)*(?:(?:command|builtin|exec|nohup|time)\\s+)*(?:[\\w./~-]*\\/)?'

/**
 * Blanks out every stretch a shell would treat as data rather than code —
 * heredoc bodies, quoted strings, comments — so that command names and
 * operators are matched only where they really are command names and operators.
 *
 * Best effort by design: unbalanced quotes leave a mangled string that matches nothing.
 */
export function scrubShell(cmd: string): string {
  return cmd
    .replace(HEREDOC, '<<HEREDOC$3')
    .replace(DOUBLE_QUOTED, '""')
    .replace(SINGLE_QUOTED, '\'\'')
    .replace(COMMENT, '$1')
    .replace(LINE_CONTINUATION, ' ')
}

/**
 * True when a scrubbed command runs `<words>` at a command position — the start
 * of the line, or after `;`, `&&`, `||`, `|`, a subshell or a backtick.
 * `words` is a regex source such as `git|gh`.
 */
export function runsCommand(scrubbed: string, words: string): boolean {
  const invocation = new RegExp(`^\\s*${COMMAND_PREFIX}(?:${words})(?![\\w-])`)
  return scrubbed
    .split(SEGMENT_BREAK)
    .some(segment => invocation.test(segment))
}

export function hasSubstitution(cmd: string): boolean {
  return /\$\(|`/.test(cmd)
}
