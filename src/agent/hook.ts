import type { ToolCall } from '../guard/check'
import type { CredentialSlot } from '../types'
import process from 'node:process'
import { checkToolCall } from '../guard/check'
import { findCredentialSlotsInCommand } from '../shell/slots'
import { MAX_LISTED_SLOTS, SLOT_FIX } from './constants'
import { gitEnv } from './git-env'
import { findCredentialSlotsInReply } from './reply'

// Claude Code and Codex share the hook protocol; they differ in tool names and
// in Codex's apply_patch, which carries a whole patch instead of one file.
function toToolCall(tool: unknown, input: Record<string, unknown>): ToolCall | null {
  const text = (key: string, from = input): string => stringField(from, key)
  const joined = (key: string): string => editList(input).map(edit => text(key, edit)).join('\n')
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

// An absent field is empty, but one of another shape (a `command` sent as an
// array) would scan as empty and let through whatever the tool makes of it.
function stringField(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  if (value === undefined || value === null)
    return ''
  if (typeof value !== 'string')
    throw new TypeError(`${key} is not a string`)
  return value
}

// The same holds one level up: a `tool_input` sent as a string, or `edits` as
// one object instead of a list, would read as nothing to check.
function record(value: unknown, key: string): Record<string, unknown> {
  if (value === undefined || value === null)
    return {}
  if (typeof value !== 'object' || Array.isArray(value))
    throw new TypeError(`${key} is not an object`)
  return value as Record<string, unknown>
}

function editList(input: Record<string, unknown>): Record<string, unknown>[] {
  const edits = input.edits ?? []
  if (!Array.isArray(edits))
    throw new TypeError('edits is not a list')
  return edits.map(edit => record(edit, 'edit'))
}

// Any exit other than 2 lets the call run, so a payload the hook cannot read
// blocks instead of passing unchecked.
export function runHook(stdin: () => string): number {
  let findings
  let slots: CredentialSlot[] = []
  try {
    const payload = record(JSON.parse(stdin()), 'payload')
    if (payload.hook_event_name === 'Stop')
      return checkReply(payload)
    const call = toToolCall(payload.tool_name, record(payload.tool_input, 'tool_input'))
    if (!call)
      return 0
    findings = checkToolCall(call, gitEnv(typeof payload.cwd === 'string' ? payload.cwd : process.cwd()))
    if (call.kind === 'shell')
      slots = findCredentialSlotsInCommand(call.command)
  }
  catch (error) {
    console.error(`Blocked by shell-secrets, it could not check the call: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
  if (findings.length > 0) {
    const list = findings.map(f => `${f.name} (${f.preview})${f.env ? `: use $${f.env}` : ''}`)
    console.error(`Blocked by shell-secrets, the call contains a secret:\n${list.join('\n')}\nReference it through an environment variable, or write it only to a gitignored file such as .env.`)
    return 2
  }
  if (slots.length > 0) {
    console.error(`Blocked by shell-secrets, the command has a slot to type a credential into, so it would send the stand-in itself:\n${listSlots(slots)}\n${SLOT_FIX}`)
    return 2
  }
  return 0
}

// A reply is no call that leaks anything, so the Stop hook never fails
// closed: a message it cannot read lets the reply stand. Once the agent has
// rewritten a reply for it, the next one may have to quote the slot it
// explains, and sending that back too would loop.
function checkReply(payload: Record<string, unknown>): number {
  const reply = payload.last_assistant_message
  if (payload.stop_hook_active === true || typeof reply !== 'string')
    return 0
  const slots = findCredentialSlotsInReply(reply)
  if (slots.length > 0) {
    const reason = `shell-secrets: this reply hands the user a command with a slot to type a credential into, which lands in shell history and, through \`!\`, in the transcript:\n${listSlots(slots)}\nRewrite it. ${SLOT_FIX}`
    process.stdout.write(`${JSON.stringify({ decision: 'block', reason })}\n`)
  }
  return 0
}

function listSlots(slots: CredentialSlot[]): string {
  const shown = slots.slice(0, MAX_LISTED_SLOTS).map(slot => slot.preview)
  return [...shown, ...slots.length > MAX_LISTED_SLOTS ? [`${slots.length - MAX_LISTED_SLOTS} more`] : []].join('\n')
}
