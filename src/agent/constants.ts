export const AGENTS = {
  claude: { dir: '.claude', file: 'settings.json', matcher: 'Bash|Write|Edit|MultiEdit|NotebookEdit' },
  codex: { dir: '.codex', file: 'hooks.json', matcher: 'Bash|apply_patch' },
} as const

export const OWN_HOOK = /^(?:node .*shell-secrets.* |npx --no-install shell-secrets )hook$/

export const USAGE = `Usage:
  shell-secrets install <claude|codex> [--project]   add the PreToolUse hook
  shell-secrets uninstall <claude|codex> [--project] remove it
  shell-secrets hook                                 run as the hook (reads the tool call on stdin)`

export const MAX_FORCED_FILES = 2000
