import type { CredentialSlot } from '../types'
import { slotsIn } from '../scan/slots'
import { scrubShell } from './parse'

/**
 * The credential slots in a shell command, as {@link findCredentialSlots}
 * finds them, outside heredoc bodies and comments: a PR body or a commit
 * message may quote a slot it is about, and neither is ever run.
 */
export function findCredentialSlotsInCommand(cmd: string): CredentialSlot[] {
  return typeof cmd === 'string' ? slotsIn(scrubShell(cmd, 'quotes'), cmd) : []
}
