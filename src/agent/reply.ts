import type { CredentialSlot } from '../types'
import { slotsIn } from '../scan/slots'
import { FENCE_CLOSE, FENCE_OPEN, INLINE_BANG } from './constants'

/**
 * The credential slots in what a reply hands the user to copy and run: its
 * fenced code blocks, and inline spans that start with `!`, which Claude Code
 * runs as a command the user types. An inline span without it is the reply
 * talking about a pattern, not handing one over. Offsets refer to `reply`.
 */
export function findCredentialSlotsInReply(reply: string): CredentialSlot[] {
  return slotsIn(copied(reply), reply)
}

// The reply with everything but the copied text blanked, so the offsets stay.
// Fences are read line by line, as CommonMark does: one closes on a line of at
// least as many of the same character, and one left open runs to the end.
function copied(reply: string): string {
  let out = ''
  let open: string | undefined
  for (const line of reply.split(/(?<=\n)/)) {
    if (open === undefined) {
      open = FENCE_OPEN.exec(line)?.[1]
      out += open === undefined ? bangSpans(line) : blank(line)
      continue
    }
    const close = FENCE_CLOSE.exec(line)?.[1]
    if (close !== undefined && close[0] === open[0] && close.length >= open.length) {
      open = undefined
      out += blank(line)
    }
    else {
      out += line
    }
  }
  return out
}

function bangSpans(line: string): string {
  let out = ''
  let copiedTo = 0
  for (const match of line.matchAll(INLINE_BANG)) {
    const start = match.index + 1
    out += blank(line.slice(copiedTo, start)) + match[1]
    copiedTo = start + match[1]!.length
  }
  return out + blank(line.slice(copiedTo))
}

// A NUL, not a blank: a flag at the end of one span must not read the next
// span's stand-in as its value across the gap.
function blank(text: string): string {
  return text.replace(/[^\n]/g, '\0')
}
