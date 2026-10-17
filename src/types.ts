/**
 * One detector. Add your own to the list passed as `rules`, or filter the
 * built-in {@link defaultRules} to disable one.
 */
export interface Rule {
  /** Stable kebab-case identifier, e.g. `github-token`. Unique within a rule list. */
  readonly id: string
  /** Human-readable kind, e.g. `GitHub token`. Two rules may share a name. */
  readonly name: string
  /** The environment variable the value conventionally lives in, or `null` when there is no usual one. */
  readonly env: string | null
  /**
   * What to match. Flags other than `g` and `d` are kept; those two are added
   * when the rule runs, so the pattern can be written without them.
   */
  readonly pattern: RegExp
  /**
   * The capture group that holds the secret itself, when the match also spans
   * context such as a variable name or a URI's host. Defaults to the whole match.
   */
  readonly secretGroup?: number
  /**
   * Rewrites the text before `pattern` runs, for a shape the pattern cannot
   * express safely. Must return a string of the same length, because finding
   * offsets refer to the original text.
   */
  readonly prepare?: (text: string) => string
  /** Drops a match outright, e.g. a credential that is only ever used locally. */
  readonly ignore?: (match: RegExpExecArray) => boolean
  /**
   * Whether the shared placeholder test (`xxxx`, `example`, `<token>`,
   * low-variety stand-ins) applies to the secret. Defaults to `true`; a rule
   * that judges its own value through `ignore` sets it to `false`.
   */
  readonly placeholders?: boolean
  /**
   * Marks a catch-all rule, such as a secret-named assignment, whose finding
   * is dropped where it overlaps one from a specific rule, so a token is
   * reported once under its provider's name.
   */
  readonly fallback?: boolean
}

/** One live-looking secret. It never carries the secret's full value. */
export interface Finding {
  /** The {@link Rule.id} that matched. */
  readonly ruleId: string
  /** The {@link Rule.name} that matched, e.g. `GitHub token`. */
  readonly name: string
  /** The environment variable to suggest instead, or `null`. */
  readonly env: string | null
  /** Offset of the secret's first character in the scanned text. */
  readonly start: number
  /** Offset just past the secret's last character; `text.slice(start, end)` is the secret. */
  readonly end: number
  /** A redacted preview safe to log, such as `ghp_********`. */
  readonly preview: string
}

/** Options shared by every scanning function. */
export interface ScanOptions {
  /** The rules to run. Defaults to {@link defaultRules}. */
  readonly rules?: readonly Rule[]
}

/** A finding on a shell command line. */
export interface CommandFinding extends Finding {
  /** The variable the secret is assigned to (`NAME=secret`), when an assignment precedes it. */
  readonly variable?: string
}

/** What {@link findSecretsInCommand} learns about a shell command. */
export interface CommandScan {
  /** Secrets that appear literally on the command line. */
  readonly findings: CommandFinding[]
  /** Files written through `>`, `>>` or `tee`, verbatim and unexpanded; `/dev/*` is left out. */
  readonly redirectTargets: string[]
  /**
   * Files that `git` or `gh` publish verbatim (`commit -F msg`, `pr create --body-file body`,
   * the file a `-F -` reads through `<` or `cat file |`) and files `git add -f` stages.
   * The scanner cannot read them; scan their contents with {@link findSecrets}.
   */
  readonly messageFiles: string[]
  /**
   * What the command publishes that no file name pins down: `git add -f -A`, a
   * `--body-file -` fed by a stage other than `cat`, a relative path after `cd`,
   * a file the command fills from anything but a literal `echo`. Treat each as
   * unscanned.
   */
  readonly unresolvedSources: string[]
}
