import type { ToolCall } from '../guard/check'
import process from 'node:process'
import { checkToolCall } from '../guard/check'
import { gitEnv } from './git-env'

// Claude Code and Codex share the hook protocol; they differ in tool names and
// in Codex's apply_patch, which carries a whole patch instead of one file.
function toToolCall(tool: unknown, input: Record<string, unknown>): ToolCall | null {
  const text = (key: string): string => typeof input[key] === 'string' ? input[key] : ''
  const edits = Array.isArray(input.edits) ? input.edits.map(record) : []
  const joined = (key: string): string => edits.map(edit => typeof edit[key] === 'string' ? edit[key] : '').join('\n')
  switch (tool) {
    case 'Bash':
      return { kind: 'shell', command: text('command') }
    case 'Write':
      return { kind: 'write', path: text('file_path'), content: text('content') }
    case 'Edit':
      return { kind: 'edit', path: text('file_path'), before: text('old_string'), after: text('new_string') }
    case 'MultiEdit':
      return { kind: 'edit', path: text('file_path'), before: joined('old_string'), after: joined('new_string') }
    case 'NotebookEdit':
      return { kind: 'write', path: text('notebook_path'), content: text('new_source') }
    case 'apply_patch':
      return { kind: 'patch', patch: text('command') || text('input') || text('patch') }
    default:
      return null
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

// Any exit other than 2 lets the call run, so a payload the hook cannot read
// blocks instead of passing unchecked.
export function runHook(stdin: string): number {
  let findings
  try {
    const payload = record(JSON.parse(stdin))
    const call = toToolCall(payload.tool_name, record(payload.tool_input))
    if (!call)
      return 0
    findings = checkToolCall(call, gitEnv(typeof payload.cwd === 'string' ? payload.cwd : process.cwd()))
  }
  catch (error) {
    console.error(`Blocked by shell-secrets, it could not check the call: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
  if (findings.length === 0)
    return 0
  const list = findings.map(f => `${f.name} (${f.preview})${f.env ? `: use $${f.env}` : ''}`)
  console.error(`Blocked by shell-secrets, the call contains a secret:\n${list.join('\n')}\nReference it through an environment variable, or write it only to a gitignored file such as .env.`)
  return 2
}
