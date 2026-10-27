export const AGENTS = {
  claude: { dir: '.claude', file: 'settings.json', matcher: 'Bash|Write|Edit|MultiEdit|NotebookEdit', skills: '.claude/skills' },
  codex: { dir: '.codex', file: 'hooks.json', matcher: 'Bash|apply_patch', skills: '.agents/skills' },
} as const

// Both agents send Stop with `last_assistant_message` and `stop_hook_active`,
// and take `{"decision":"block"}` on stdout as "rewrite the reply". Stop has no
// matcher in either.
export const EVENTS = ['PreToolUse', 'Stop'] as const

export const STATUS = {
  PreToolUse: 'Scanning for secrets',
  Stop: 'Checking the reply for credential slots',
} as const

export const SKILL = 'credential-handling'

// A skill directory of this name may be the user's own, so install and
// uninstall touch only one that holds this file, which install writes.
export const SKILL_MARKER = '.installed-by-shell-secrets'

// The exact commands hookCommands writes, past and present, so a user hook that
// merely mentions shell-secrets is never taken for one. The Stop one has no
// `|| exit 2`.
export const OWN_HOOK = /^(?:(?:node|n='(?:[^']|'\\'')*'; \[ -x "\$n" \] \|\| n=node; "\$n") '(?:[^']|'\\'')*shell-secrets(?:[^']|'\\'')*\/cli\.mjs' hook|npx --no-install shell-secrets hook)(?: \|\| exit 2)?$/

export const USAGE = `Usage:
  shell-secrets install <claude|codex> [--project]   add the PreToolUse and Stop hooks and the credential-handling skill
  shell-secrets uninstall <claude|codex> [--project] remove them
  shell-secrets hook                                 run as the hook (reads the tool call or the reply on stdin)`

export const SLOT_FIX = 'Pass the credential by reference instead: $NAME, $(gh auth token), one key read from a gitignored .env in the same call, $(security find-generic-password -s <service> -w). If nothing on the machine holds it, hand the user a no-echo login to run: `! gh auth login`, or `! security add-generic-password -U -a "$USER" -s <service> -w`. The credential-handling skill has the details.'

// What a reply hands over to copy: a fence of three or more backticks or
// tildes, and an inline span the user types with Claude Code's `!` prefix.
export const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/
export const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?\n?$/
export const INLINE_BANG = /`(![^`\n]+)`/g

// The slots a block message names; past them it counts the rest.
export const MAX_LISTED_SLOTS = 3

export const MAX_FORCED_FILES = 2000

// The caller lets a call run unchecked once the hook's timeout passes (10 s in
// the entry `install` writes), so the work stops short of it. What is left
// undone answers as the check that blocks.
export const TIME_BUDGET_MS = 6000

// A published file larger than this is no message anyone wrote, and reading it
// takes the time and memory the hook does not have; across all files in one
// call the cap is the second figure.
export const MAX_FILE_BYTES = 16 << 20
export const MAX_READ_BYTES = 64 << 20
