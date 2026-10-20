export const AGENTS = {
  claude: { dir: '.claude', file: 'settings.json', matcher: 'Bash|Write|Edit|MultiEdit|NotebookEdit' },
  codex: { dir: '.codex', file: 'hooks.json', matcher: 'Bash|apply_patch' },
} as const

// The exact commands hookCommand writes, past and present, so a user hook that
// merely mentions shell-secrets is never taken for one.
export const OWN_HOOK = /^(?:(?:node|n='(?:[^']|'\\'')*'; \[ -x "\$n" \] \|\| n=node; "\$n") '(?:[^']|'\\'')*shell-secrets(?:[^']|'\\'')*\/cli\.mjs' hook|npx --no-install shell-secrets hook)(?: \|\| exit 2)?$/

export const USAGE = `Usage:
  shell-secrets install <claude|codex> [--project]   add the PreToolUse hook
  shell-secrets uninstall <claude|codex> [--project] remove it
  shell-secrets hook                                 run as the hook (reads the tool call on stdin)`

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
