import type { Finding, ScanOptions } from '../types'
import { findNewSecrets, findSecrets } from '../scan/find'
import { findSecretsInCommand, onlyWritesTo } from '../shell/command'
import { MAX_LOOKUPS, PATCH_BLANK, PATCH_FILE } from './constants'

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
  const bounded = withinLookups(env)
  switch (call.kind) {
    case 'shell':
      return checkShell(call.command, bounded, options)
    case 'write':
      return unlessIgnored(call.path, findSecrets(call.content, options), bounded)
    case 'edit':
      return unlessIgnored(call.path, findNewSecrets(call.before, call.after, options), bounded)
    case 'patch':
      return checkPatch(call.patch, bounded, options)
  }
}

// Every distinct path may cost a git process, and the hook has seconds for the
// whole call: a command that names thousands of paths would outlast its
// timeout, which lets the call run unchecked. Each path is asked about once, and
// past the limit the answer is the one that blocks.
function withinLookups(env: GuardEnv): GuardEnv {
  const limited = <R>(ask: (path: string) => R, beyond: R): ((path: string) => R) => {
    const known = new Map<string, R>()
    return (path) => {
      if (!known.has(path))
        known.set(path, known.size < MAX_LOOKUPS ? ask(path) : beyond)
      return known.get(path) as R
    }
  }
  return {
    ...env,
    isIgnored: limited(env.isIgnored, false),
    listIgnored: env.listIgnored && limited(env.listIgnored, null),
  }
}

// Only a path that would take a secret is asked about, so a call without one
// costs no process.
function unlessIgnored(path: string | undefined, found: Finding[], env: GuardEnv): Finding[] {
  return found.length > 0 && path !== undefined && env.isIgnored(path) ? [] : found
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

function trimEnd(line: string): string {
  let end = line.length
  while (end > 0 && PATCH_BLANK.test(line[end - 1]!))
    end--
  return line.slice(0, end)
}

function trimStart(line: string): string {
  let start = 0
  while (start < line.length && PATCH_BLANK.test(line[start]!))
    start++
  return line.slice(start)
}

// Codex's apply_patch format: only the `+` lines of a hunk are new text, and
// they land in the last file named, which a `Move to` line can change. Any
// other `***` line ends the exemption, so a header this does not recognise
// cannot carry an ignored file's exemption into the next file.
//
// Codex finds a header past blanks on either side of the line, except inside
// an Update hunk, where a line that starts with a blank is context; the path
// is whatever follows the marker, so `Add File:  .env` writes ` .env`. It
// trims as Rust does, which strips other characters than `String#trim`.
function checkPatch(patch: string, env: GuardEnv, options: ScanOptions): Finding[] {
  const findings: Finding[] = []
  let file: string | undefined
  let updating = false
  let added: string[] = []
  const flush = (): void => {
    if (added.length > 0)
      findings.push(...unlessIgnored(file, findSecrets(added.join('\n'), options), env))
    added = []
  }
  for (const raw of patch.split(/\r?\n/)) {
    const line: string = updating ? trimEnd(raw) : trimStart(trimEnd(raw))
    const header = PATCH_FILE.exec(line)
    if (header) {
      flush()
      file = header[2]
      updating = header[1] !== 'Add File'
    }
    else if (raw.startsWith('+')) {
      added.push(raw.slice(1))
    }
    else if (line.startsWith('*** ')) {
      flush()
      file = undefined
      updating &&= line === '*** End of File'
    }
  }
  flush()
  return findings
}
