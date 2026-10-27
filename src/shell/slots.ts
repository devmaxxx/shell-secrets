import type { CredentialSlot } from '../types'
import { slotsIn } from '../scan/slots'
import { TEXT_SEARCH } from './constants'
import { endOf, heredocAt, scrubShell, segments } from './parse'

/**
 * The credential slots in a shell command, as {@link findCredentialSlots}
 * finds them, outside heredoc bodies, comments and the arguments of a command
 * that searches or edits text (`grep`, `rg`, `sed`, `awk`, `jq`, `perl`): a PR
 * body or a commit message may quote a slot it is about, a pattern may look
 * for one, and none of them is ever run.
 */
export function findCredentialSlotsInCommand(cmd: string): CredentialSlot[] {
  if (typeof cmd !== 'string')
    return []
  const code = scrubShell(cmd)
  const quoted = scrubShell(cmd, 'quotes')
  const scanned = quoted.split('')
  const fill = (from: number, to: number, source?: string): void => {
    for (let i = from; i < to; i++)
      scanned[i] = source?.[i] ?? ' '
  }
  // A substitution in a search's arguments still runs, so a command in it that
  // is no search gets its text back.
  for (const segment of segments(code)) {
    const search = TEXT_SEARCH.exec(segment.text)
    if (search)
      fill(segment.start + search[0].length, endOf(segment))
    else if (segment.within)
      fill(segment.start, endOf(segment), quoted)
  }
  // The scrub keeps a quoted string whole, so a heredoc inside a substitution
  // in one, `git commit -m "$(cat <<'EOF' … EOF)"`, is found where the code
  // reading leaves its `<<` standing.
  for (const opener of code.matchAll(/(?<!<)<<(?!<)/g)) {
    const doc = heredocAt(cmd, opener.index + 2)
    if (doc)
      fill(doc.bodyAt, doc.bodyAt + doc.body.length)
  }
  return slotsIn(scanned.join(''), cmd)
}
