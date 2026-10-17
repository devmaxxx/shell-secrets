import type { Finding, ScanOptions } from './types'
import { findSecretsInCommand, onlyWritesTo } from './command'
import { findNewSecrets, findSecrets } from './scan'

/** An agent's tool call, reduced to what decides whether it leaks a secret. */
export type ToolCall
  = | { kind: 'shell', command: string }
    | { kind: 'write', path: string, content: string }
    | { kind: 'edit', path: string, before: string, after: string }
    | { kind: 'patch', patch: string }

/** The file system as {@link checkToolCall} sees it, so the policy stays testable. */
export interface GuardEnv {
  /** `true` when a secret may land in `path`: git ignores it and does not track it. */
  isIgnored: (path: string) => boolean
  /** The file's contents, or `null` when it cannot be read or does not exist. */
  readFile: (path: string) => string | null
  /**
   * The untracked, ignored files under a directory, which `git add -f dir`
   * would stage, or `null` when `path` is no directory or they cannot be
   * listed. Without it, a forced add of a directory blocks the call.
   */
  listIgnored?: (path: string) => string[] | null
}

/**
 * The secrets a tool call would leak. A secret that only lands in ignored files
 * is not a leak; neither is one an edit keeps without adding.
 */
export function checkToolCall(call: ToolCall, env: GuardEnv, options: ScanOptions = {}): Finding[] {
  switch (call.kind) {
    case 'shell':
      return checkShell(call.command, env, options)
    case 'write':
      return env.isIgnored(call.path) ? [] : findSecrets(call.content, options)
    case 'edit':
      return env.isIgnored(call.path) ? [] : findNewSecrets(call.before, call.after, options)
    case 'patch':
      return checkPatch(call.patch, env, options)
  }
}

function checkShell(command: string, env: GuardEnv, options: ScanOptions): Finding[] {
  const scan = findSecretsInCommand(command, options)
  if (scan.findings.length > 0 && onlyWritesTo(command, env.isIgnored))
    return []
  // git and gh publish these files verbatim, so their contents are part of the
  // call. One that cannot be read, or a source no file name pins down, blocks
  // the call: letting it through would read an unscanned file as "no file".
  const scanFile = (file: string): Finding[] => {
    const text = env.readFile(file)
    return text === null ? [unscanned(file)] : findSecrets(text, options)
  }
  const published = scan.messageFiles.flatMap((file) => {
    if (env.readFile(file) !== null)
      return scanFile(file)
    const inside = env.listIgnored?.(file)
    return inside ? inside.flatMap(scanFile) : [unscanned(file)]
  })
  return [...scan.findings, ...published, ...scan.unresolvedSources.map(unscanned)]
}

function unscanned(source: string): Finding {
  return { ruleId: 'unscanned-published-file', name: 'published file it could not scan', env: null, start: 0, end: 0, preview: source }
}

const PATCH_FILE = /^\*\*\* (?:Add File|Update File|Move to): (.+)$/

// Codex's apply_patch format: only the `+` lines of a hunk are new text, and
// they land in the last file named, which a `Move to` line can change. Any
// other `***` line ends the exemption, so a header this does not recognise
// cannot carry an ignored file's exemption into the next file.
function checkPatch(patch: string, env: GuardEnv, options: ScanOptions): Finding[] {
  const findings: Finding[] = []
  let ignored = false
  let added: string[] = []
  const flush = (): void => {
    if (!ignored && added.length > 0)
      findings.push(...findSecrets(added.join('\n'), options))
    added = []
  }
  for (const line of patch.split(/\r?\n/)) {
    const file = PATCH_FILE.exec(line)
    if (file) {
      flush()
      ignored = env.isIgnored(file[1]!.trim())
    }
    else if (line.startsWith('+')) {
      added.push(line.slice(1))
    }
    else if (line.startsWith('*** ')) {
      flush()
      ignored = false
    }
  }
  flush()
  return findings
}
