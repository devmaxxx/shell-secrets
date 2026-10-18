import type { Heredoc, Segment } from './parse'
import { ANSI_C_STRING, ARGUMENTS_FROM_STDIN, CAT_HEREDOC, CLOSING_PAREN, FIELD_FROM_FILE, GH_GRAMMARS, GH_WRITES, GIT_GRAMMARS, GIT_PLACE_OPTION, GIT_VALUED_GLOBAL, LITERAL_ECHO, REDIRECT_OPERATOR, SHELL_COMMAND_OPTION, SHELLS } from './constants'
import { heredocAt, skipBlanks, unquote, wordAt } from './parse'

type LongOption = readonly [name: string, shortestPrefix: number, valued: boolean]

/** How a subcommand's arguments read: see GIT_GRAMMARS. */
export interface Grammar {
  /** Short options that take a value, glued (`-Fmsg`) or as the next word. */
  readonly short: string
  readonly long: readonly LongOption[]
  readonly files: readonly string[]
}

/** What one segment of a command line publishes. */
export interface Publication {
  /** It runs git or gh to publish, so it is not a writer of the files it names. */
  readonly publishes: boolean
  /** Its content comes from what it names or substitutes, not only from files. */
  readonly content: boolean
  /** Files it publishes; `-` is its stdin. */
  readonly files: string[]
  readonly unresolved: string[]
  /** Command text it runs in a shell of its own (`bash -c`, `eval`, a heredoc). */
  readonly scripts: string[]
  /** It points git at another directory, where a relative path means something else. */
  readonly elsewhere: boolean
}

interface Word { readonly value: string, readonly at: number }

interface Option { readonly name: string, readonly value: string | undefined, readonly valued: boolean }

interface Parsed { readonly options: Option[], readonly operands: string[] }

const COMMANDS = new Set(['git', 'gh', 'eval', ...SHELLS])

const NOTHING: Publication = Object.freeze({ publishes: false, content: false, files: [], unresolved: [], scripts: [], elsewhere: false })

const nameOf = (word: Word): string => word.value.slice(word.value.lastIndexOf('/') + 1)

/**
 * The segment's words as the shell passes them, unquoted, with redirects and
 * their targets left out; `heredocs` holds the offset after each `<<`.
 */
function wordsOf(cmd: string, segment: Segment): { words: Word[], heredocs: number[], hereStrings: string[] } {
  const end = segment.start + segment.text.length
  const words: Word[] = []
  const heredocs: number[] = []
  const hereStrings: string[] = []
  let at = skipBlanks(cmd, segment.start)
  while (at < end) {
    const raw = wordAt(cmd, at)
    if (raw && !(/^\d+$/.test(raw) && /[<>]/.test(cmd[at + raw.length] ?? ''))) {
      words.push({ value: unquote(raw), at })
      at = skipBlanks(cmd, at + raw.length)
      continue
    }
    at += raw.length
    REDIRECT_OPERATOR.lastIndex = at
    const operator = REDIRECT_OPERATOR.exec(cmd)
    if (!operator)
      break
    at += operator[0].length
    if (operator[0] === '<<')
      heredocs.push(at)
    at = skipBlanks(cmd, at)
    if (operator[0] === '<<<')
      hereStrings.push(unquote(wordAt(cmd, at)))
    at = skipBlanks(cmd, at + wordAt(cmd, at).length)
  }
  return { words, heredocs, hereStrings }
}

function parse(words: readonly Word[], grammar: Grammar): Parsed {
  const options: Option[] = []
  const operands: string[] = []
  let parsingOptions = true
  for (let k = 0; k < words.length; k++) {
    const word = words[k]!.value
    if (!parsingOptions || word === '-' || !word.startsWith('-')) {
      operands.push(word)
    }
    else if (word === '--') {
      parsingOptions = false
    }
    else if (word.startsWith('--')) {
      const eq = word.indexOf('=')
      const given = word.slice(2, eq < 0 ? undefined : eq)
      const long = grammar.long.find(([name, shortest]) => name === given || (shortest > 0 && given.length >= shortest && name.startsWith(given)))
      if (long) {
        const [name, , valued] = long
        options.push({ name, valued, value: eq >= 0 ? word.slice(eq + 1) : valued ? words[++k]?.value : undefined })
      }
    }
    else {
      for (let l = 1; l < word.length; l++) {
        const name = word[l]!
        if (grammar.short.includes(name)) {
          options.push({ name, valued: true, value: l + 1 < word.length ? word.slice(l + 1) : words[++k]?.value })
          break
        }
        options.push({ name, valued: false, value: undefined })
      }
    }
  }
  return { options, operands }
}

const has = (parsed: Parsed, ...names: string[]): boolean => parsed.options.some(o => names.includes(o.name))

// A file option left without a value, or with an empty one (`-F <(…)` leaves
// none, the substitution being no word), is a source that cannot be pinned down.
function addFile(path: string | undefined, publication: Publication, text: string): void {
  if (path)
    publication.files.push(path)
  else
    publication.unresolved.push(text)
}

function optionFiles(parsed: Parsed, grammar: Grammar, publication: Publication, text: string): void {
  for (const option of parsed.options.filter(o => o.valued && grammar.files.includes(o.name)))
    addFile(option.value, publication, text)
}

function git(words: readonly Word[], fromStdin: boolean, text: string): Publication {
  let j = 0
  let elsewhere = false
  while (j < words.length && words[j]!.value.startsWith('-')) {
    const option = words[j]!.value
    // An alias defined on the command line can stand for any subcommand.
    if (option === '-c' && /^alias\./i.test(words[j + 1]?.value ?? ''))
      return { ...NOTHING, publishes: true, unresolved: [text] }
    elsewhere ||= GIT_PLACE_OPTION.test(option)
    j += GIT_VALUED_GLOBAL.test(option) ? 2 : 1
  }
  const sub = words[j]?.value === 'stage' ? 'add' : words[j]?.value ?? ''
  if (sub === 'fast-import')
    return { ...NOTHING, publishes: true, unresolved: [text] }
  const grammar = GIT_GRAMMARS[sub]
  if (!grammar)
    return NOTHING
  const parsed = parse(words.slice(j + 1), grammar)
  const publication: Publication = { ...NOTHING, publishes: true, content: true, elsewhere, files: [], unresolved: [] }
  if (sub === 'add' || sub === 'update-index' || sub === 'hash-object') {
    const stages = sub === 'add' ? has(parsed, 'f', 'force') : sub === 'update-index' ? has(parsed, 'add', 'index-info') : has(parsed, 'w')
    if (!stages)
      return { ...publication, content: false }
    // The paths arrive from stdin or a file this cannot see.
    if (fromStdin || has(parsed, 'pathspec-from-file', 'stdin', 'stdin-paths', 'index-info'))
      return { ...publication, unresolved: [text] }
    const all = sub === 'add' && parsed.operands.length === 0 && has(parsed, 'A', 'all')
    publication.files.push(...(all ? ['.'] : parsed.operands))
    return publication
  }
  if (fromStdin)
    return { ...publication, unresolved: [text] }
  optionFiles(parsed, grammar, publication, text)
  return publication
}

function gh(words: readonly Word[], fromStdin: boolean, text: string): Publication {
  const [group = '', sub = ''] = words.map(w => w.value)
  const key = group === 'pr' || group === 'issue' || group === 'api' ? group : `${group} ${sub}`
  const grammar = GH_GRAMMARS[key]
  if (!grammar || ((key === 'pr' || key === 'issue') && !GH_WRITES.has(sub)))
    return NOTHING
  if (fromStdin)
    return { ...NOTHING, publishes: true, content: true, unresolved: [text] }
  const parsed = parse(words.slice(key === group ? 1 : 2), grammar)
  // `gh api` without a field or an input only reads.
  const content = key !== 'api' || has(parsed, 'F', 'f', 'field', 'raw-field', 'input')
  const publication: Publication = { ...NOTHING, publishes: true, content, files: [], unresolved: [] }
  optionFiles(parsed, grammar, publication, text)
  // A release asset may carry a display label after `#`.
  const assets = parsed.operands.slice(key === 'pr' || key === 'issue' ? parsed.operands.length : 1).map(path => path.replace(/#[^/]*$/, ''))
  if (key === 'release create' || key === 'release upload' || key === 'gist edit')
    assets.forEach(path => addFile(path, publication, text))
  // With no file named, `gh gist create` publishes its stdin.
  if (key === 'gist create')
    (parsed.operands.length > 0 ? parsed.operands : ['-']).forEach(path => addFile(path, publication, text))
  if (key === 'api') {
    for (const option of parsed.options.filter(o => o.name === 'F' || o.name === 'field')) {
      const file = FIELD_FROM_FILE.exec(option.value ?? '')
      if (file)
        addFile(file[1], publication, text)
    }
  }
  return publication
}

/**
 * The shell code a segment hands to a shell of its own: `bash -c '…'`,
 * `eval …`, or a heredoc fed to a shell. A script read from a file or a pipe
 * is beyond what a command line shows.
 */
function scriptsOf(cmd: string, words: readonly Word[], heredocs: readonly number[], hereStrings: readonly string[], command: number): string[] {
  const name = nameOf(words[command]!)
  const rest = words.slice(command + 1)
  if (name === 'eval')
    return [rest.map(w => w.value).join(' ')]
  const flag = rest.findIndex(w => SHELL_COMMAND_OPTION.test(w.value))
  if (flag >= 0) {
    const script = rest.slice(flag + 1).find(w => !w.value.startsWith('-'))
    return script ? [script.value] : []
  }
  return [...hereStrings, ...heredocs.map(at => heredocAt(cmd, at)).filter((doc): doc is Heredoc => doc !== null).map(doc => doc.body)]
}

/**
 * What a segment publishes through git or gh. The command is found by name
 * wherever it stands, unquoted (`'git'`, `\git`, `/usr/bin/git`), so a wrapper
 * this does not know (`nice`, `timeout 5`, `find -exec`) cannot hide it, at
 * worst it reads a file that is not one. Arguments built from stdin by
 * `xargs` or `parallel` cannot be read.
 */
export function publicationOf(cmd: string, segment: Segment): Publication {
  const { words, heredocs, hereStrings } = wordsOf(cmd, segment)
  const text = segment.text.trim()
  const command = words.findIndex(w => COMMANDS.has(nameOf(w)))
  if (command < 0)
    return NOTHING
  const name = nameOf(words[command]!)
  const fromStdin = words.slice(0, command).some(w => ARGUMENTS_FROM_STDIN.has(nameOf(w)))
  if (name === 'git')
    return git(words.slice(command + 1), fromStdin, text)
  if (name === 'gh')
    return gh(words.slice(command + 1), fromStdin, text)
  return { ...NOTHING, scripts: scriptsOf(cmd, words, heredocs, hereStrings, command) }
}

// The offset after a `$(…)` whose output is text the command already shows,
// a quoted heredoc or a plain echo, or -1 when its output is unknown.
function literalSubstitutionEnd(cmd: string, at: number): number {
  CAT_HEREDOC.lastIndex = at
  if (CAT_HEREDOC.test(cmd)) {
    const doc = heredocAt(cmd, CAT_HEREDOC.lastIndex)
    if (!doc || doc.rest.trim() !== '' || (!doc.quoted && /\$\(|`/.test(doc.body)))
      return -1
    CLOSING_PAREN.lastIndex = doc.end
    return CLOSING_PAREN.test(cmd) ? CLOSING_PAREN.lastIndex : -1
  }
  LITERAL_ECHO.lastIndex = at
  return LITERAL_ECHO.test(cmd) ? LITERAL_ECHO.lastIndex : -1
}

/**
 * Whether the text from `from` holds a command or process substitution whose
 * output is unknown, outside single quotes. It stops at the end of the simple
 * command unless `to` is given, and skips the literal `$(cat <<'EOF' … )` that
 * agents write commit messages with.
 */
export function hasOpaqueSubstitution(cmd: string, from: number, to?: number): boolean {
  const end = to ?? cmd.length
  let quoted = false
  for (let i = from; i < end; i++) {
    const c = cmd[i]!
    if (c === '\\') {
      i++
    }
    else if (!quoted && c === '$' && cmd[i + 1] === '\'') {
      ANSI_C_STRING.lastIndex = i
      if (!ANSI_C_STRING.test(cmd))
        return false
      i = ANSI_C_STRING.lastIndex - 1
    }
    else if (!quoted && c === '\'') {
      const close = cmd.indexOf('\'', i + 1)
      if (close < 0)
        return false
      i = close
    }
    else if (c === '"') {
      quoted = !quoted
    }
    else if (!quoted && to === undefined && '\n;&|)'.includes(c)) {
      return false
    }
    else if (c === '`' || (!quoted && (c === '<' || c === '>') && cmd[i + 1] === '(')) {
      return true
    }
    else if (c === '$' && cmd[i + 1] === '(') {
      const after = cmd[i + 2] === '(' ? -1 : literalSubstitutionEnd(cmd, i + 2)
      if (after < 0)
        return true
      i = after - 1
    }
  }
  return false
}
