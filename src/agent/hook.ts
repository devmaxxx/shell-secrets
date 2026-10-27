import type { HookPlugin, InstallPlace } from 'agent-base-kit'
import type { CredentialSlot } from '../types'
import { join } from 'node:path'
import { defineHook } from 'agent-base-kit'
import { checkToolCall } from '../guard/check'
import { findCredentialSlotsInCommand } from '../shell/slots'
import { HOOK_TIMEOUT_S, MAX_LISTED_SLOTS, OWN_HOOK, SKILL, SKILL_DIRS, SLOT_FIX, STATUS } from './constants'
import { gitEnv } from './git-env'
import { assertSkillSource, installSkill, removeSkill } from './install'
import { findCredentialSlotsInReply } from './reply'

function listSlots(slots: CredentialSlot[]): string {
  const shown = slots.slice(0, MAX_LISTED_SLOTS).map(slot => slot.preview)
  return [...shown, ...slots.length > MAX_LISTED_SLOTS ? [`${slots.length - MAX_LISTED_SLOTS} more`] : []].join('\n')
}

const skillDir = ({ agent, scope, home, cwd }: InstallPlace): string => join(scope === 'project' ? cwd : home, SKILL_DIRS[agent], SKILL)

/**
 * The shell-secrets hook, with the credential-handling skill install copies
 * from `skills`, the package's `skills/` directory.
 */
export function shellSecrets(skills: string): HookPlugin {
  const source = join(skills, SKILL)
  return defineHook({
    name: 'shell-secrets',
    kinds: ['shell', 'write', 'edit', 'patch'],
    check: (call, { cwd }) => {
      const findings = checkToolCall(call, gitEnv(cwd))
      if (findings.length > 0) {
        const list = findings.map(f => `${f.name} (${f.preview})${f.env ? `: use $${f.env}` : ''}`)
        return { block: true, reason: `Blocked by shell-secrets, the call contains a secret:\n${list.join('\n')}\nReference it through an environment variable, or write it only to a gitignored file such as .env.` }
      }
      const slots = call.kind === 'shell' ? findCredentialSlotsInCommand(call.command) : []
      if (slots.length > 0)
        return { block: true, reason: `Blocked by shell-secrets, the command has a slot to type a credential into, so it would send the stand-in itself:\n${listSlots(slots)}\n${SLOT_FIX}` }
      return { block: false }
    },
    statusMessage: STATUS.PreToolUse,
    timeout: HOOK_TIMEOUT_S,
    ownCommands: [OWN_HOOK],
    events: {
      // A reply is no call that leaks anything, so this one lets the reply
      // stand on any fault, and the kit passes the reply the agent rewrote for
      // it, which may have to quote the slot it explains.
      Stop: {
        check: ({ reply }) => {
          const slots = findCredentialSlotsInReply(reply)
          if (slots.length === 0)
            return { block: false }
          return { block: true, reason: `shell-secrets: this reply hands the user a command with a slot to type a credential into, which lands in shell history and, through \`!\`, in the transcript:\n${listSlots(slots)}\nRewrite it. ${SLOT_FIX}` }
        },
        statusMessage: STATUS.Stop,
      },
    },
    // A failed skill step puts the config back, so install is all or nothing.
    // The hook works without the skill, so a skill of the same name the user
    // keeps is left in place with a warning rather than failing the install.
    onInstall: (place) => {
      assertSkillSource(source)
      const target = skillDir(place)
      return installSkill(source, target)
        ? { notes: [`Installed the ${SKILL} skill in ${target}`] }
        : { warnings: [`left ${target} as it is, since shell-secrets did not install it`] }
    },
    onUninstall: (place) => {
      const target = skillDir(place)
      const removed = removeSkill(target)
      if (removed === 'foreign')
        return { warnings: [`left ${target} as it is, since shell-secrets did not install it`] }
      return removed === 'removed' ? { notes: [`Removed the ${SKILL} skill from ${target}`] } : undefined
    },
  })
}
