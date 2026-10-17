export const AGENTS = {
  claude: { dir: '.claude', file: 'settings.json', matcher: 'Bash|Write|Edit|MultiEdit|NotebookEdit' },
  codex: { dir: '.codex', file: 'hooks.json', matcher: 'Bash|apply_patch' },
} as const

// The exact commands hookCommand writes, past and present, so a user hook that
// merely mentions shell-secrets is never taken for one.
export const OWN_HOOK = /^(?:node '(?:[^']|'\\'')*shell-secrets(?:[^']|'\\'')*\/cli\.mjs' hook|npx --no-install shell-secrets hook)(?: \|\| exit 2)?$/

export const USAGE = `Usage:
  shell-secrets install <claude|codex> [--project]   add the PreToolUse hook
  shell-secrets uninstall <claude|codex> [--project] remove it
  shell-secrets hook                                 run as the hook (reads the tool call on stdin)`

export const MAX_FORCED_FILES = 2000
