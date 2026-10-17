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
  // call. One that cannot be read blocks the call unless the command writes it
  // first: a `cd` earlier in the command, or a `$` in the path, would otherwise
  // let an unscanned file through as "no file".
  const published = scan.messageFiles.flatMap((file) => {
    const text = env.readFile(file)
    if (text !== null)
      return findSecrets(text, options)
    return scan.redirectTargets.includes(file) ? [] : [unreadable(file)]
  })
  return [...scan.findings, ...published]
}

function unreadable(file: string): Finding {
  return { ruleId: 'unreadable-message-file', name: 'unscanned message file', env: null, start: 0, end: 0, preview: file }
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
