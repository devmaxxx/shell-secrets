import type { Stats } from 'node:fs'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { SKILL_MARKER } from './constants'

function entryAt(path: string): Stats | null {
  try {
    return lstatSync(path)
  }
  catch {
    return null
  }
}

// A link is never taken for the copy install made, whatever it points at.
function ownsSkill(dir: string): boolean {
  return entryAt(dir)?.isDirectory() === true && existsSync(join(dir, SKILL_MARKER))
}

export function assertSkillSource(source: string): void {
  if (!existsSync(join(source, 'SKILL.md')))
    throw new Error(`${source} holds no skill to install; run install from the published package or a checkout`)
}

/**
 * Copies the skill in `source` to `target`, replacing an earlier copy. Returns
 * `false`, and writes nothing, when `target` holds something install did not
 * put there. The copy is staged and renamed in, so the agent never reads a
 * half-written skill.
 */
export function installSkill(source: string, target: string): boolean {
  assertSkillSource(source)
  if (entryAt(target) && !ownsSkill(target))
    return false
  mkdirSync(dirname(target), { recursive: true })
  // A fresh name, so a directory that only shares the staging name is never
  // the one copied into or removed.
  const staging = mkdtempSync(`${target}.`)
  try {
    cpSync(source, staging, { recursive: true })
    writeFileSync(join(staging, SKILL_MARKER), '')
    rmSync(target, { recursive: true, force: true })
    renameSync(staging, target)
  }
  finally {
    rmSync(staging, { recursive: true, force: true })
  }
  return true
}

/** Removes the skill install put in `target`, and leaves anything else there. */
export function removeSkill(target: string): 'removed' | 'absent' | 'foreign' {
  if (!entryAt(target))
    return 'absent'
  if (!ownsSkill(target))
    return 'foreign'
  rmSync(target, { recursive: true, force: true })
  return 'removed'
}
