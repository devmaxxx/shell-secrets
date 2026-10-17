import type { GuardEnv } from '../guard/check'
import { spawnSync } from 'node:child_process'
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { MAX_FORCED_FILES } from './constants'

export function gitEnv(cwd: string): GuardEnv {
  return {
    // check-ignore answers no for a tracked file and for a path outside any
    // repository, so only an untracked, ignored file counts. It does not follow
    // links, so the file a write would really land in is the one asked about.
    isIgnored: (path) => {
      const full = landsIn(resolve(cwd, path))
      return full !== null && !isHardLinked(full) && spawnSync('git', ['-C', dirname(full), 'check-ignore', '-q', basename(full)]).status === 0
    },
    readFile: (path) => {
      try {
        return readFileSync(expand(cwd, path), 'utf8')
      }
      catch {
        return null
      }
    },
    listIgnored: (path) => {
      const dir = expand(cwd, path)
      try {
        if (!statSync(dir).isDirectory())
          return null
      }
      catch {
        return null
      }
      const listed = spawnSync('git', ['-C', dir, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 16 << 20 })
      const files = listed.status === 0 ? listed.stdout.split('\0').filter(Boolean) : null
      // A forced add of a dependency or build tree is too big to scan inside a
      // hook's time budget, so it stays blocked as unscanned.
      return files && files.length <= MAX_FORCED_FILES ? files.map(file => join(dir, file)) : null
    },
  }
}

// A hard link shares its bytes with every other name for the file, a tracked
// one included, and nothing on the ignored name says which.
function isHardLinked(full: string): boolean {
  try {
    return statSync(full).nlink > 1
  }
  catch {
    return false
  }
}

function expand(cwd: string, path: string): string {
  return resolve(cwd, path.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/)/, homedir()))
}

// The real path a write to `full` lands in, or `null` for a link whose target
// is missing, which a write would create wherever it points.
function landsIn(full: string): string | null {
  try {
    return realpathSync(full)
  }
  catch {
    try {
      if (lstatSync(full).isSymbolicLink())
        return null
    }
    catch {}
    try {
      return join(realpathSync(dirname(full)), basename(full))
    }
    catch {
      return full
    }
  }
}
