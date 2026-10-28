// Where each agent looks for a skill, under the home directory or the project.
export const SKILL_DIRS = { claude: '.claude/skills', codex: '.agents/skills' } as const

export const STATUS = {
  PreToolUse: 'Scanning for secrets',
  Stop: 'Checking the reply for credential slots',
} as const

// Seconds the agent waits for each hook entry.
export const HOOK_TIMEOUT_S = 10

export const SKILL = 'credential-handling'

// A skill directory of this name may be the user's own, so install and
// uninstall touch only one that holds this file, which install writes.
export const SKILL_MARKER = '.installed-by-shell-secrets'

// Every command shell-secrets wrote before it ran on agent-base-kit, which the
// kit's own forms miss when the path is not a directory named exactly
// shell-secrets (a fork, a checkout called my-shell-secrets), so install
// replaces and uninstall removes them. A user hook that merely mentions
// shell-secrets is never taken for one. The Stop one has no `|| exit 2`.
export const OWN_HOOK = /^(?:(?:node|n='(?:[^']|'\\'')*'; \[ -x "\$n" \] \|\| n=node; "\$n") '(?:[^']|'\\'')*shell-secrets(?:[^']|'\\'')*\/cli\.mjs' hook|npx --no-install shell-secrets hook)(?: \|\| exit 2)?$/

export const SLOT_FIX = 'Pass the credential by reference instead: $NAME, $(gh auth token), one key read from a gitignored .env in the same call, $(security find-generic-password -s <service> -w). If nothing on the machine holds it, hand the user a no-echo login to run: `! gh auth login`, or `! security add-generic-password -U -a "$USER" -s <service> -w`. The credential-handling skill has the details.'

// What a reply hands over to copy: a fence of three or more backticks or
// tildes, and an inline span the user types with Claude Code's `!` prefix.
export const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/
export const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?\n?$/
export const INLINE_BANG = /`(![^`\n]+)`/g

// The slots a block message names; past them it counts the rest.
export const MAX_LISTED_SLOTS = 3

export const MAX_FORCED_FILES = 2000

// The caller lets a call run unchecked once the hook's timeout passes
// (HOOK_TIMEOUT_S), so the work stops short of it. What is left
// undone answers as the check that blocks.
export const TIME_BUDGET_MS = 6000

// A published file larger than this is no message anyone wrote, and reading it
// takes the time and memory the hook does not have; across all files in one
// call the cap is the second figure.
export const MAX_FILE_BYTES = 16 << 20
export const MAX_READ_BYTES = 64 << 20
