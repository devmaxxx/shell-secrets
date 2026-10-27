import { spawnSync } from 'node:child_process'
import { mkdtempSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_FILE_BYTES, MAX_READ_BYTES, TIME_BUDGET_MS } from '../../src/agent/constants'
import { gitEnv } from '../../src/agent/git-env'

describe('gitEnv', () => {
  afterEach(() => vi.useRealTimers())
  const repo = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'ss-env-'))
    spawnSync('git', ['init', '-q', dir])
    writeFileSync(join(dir, '.gitignore'), '.env\n')
    return dir
  }
  // A sparse file costs no disk, and reads back as zeros.
  const sparse = (path: string, size: number): void => {
    writeFileSync(path, '')
    truncateSync(path, size)
  }

  it('reads a regular file, and nothing that is not one or is too large', () => {
    const dir = repo()
    writeFileSync(join(dir, 'msg.txt'), 'fix: x\n')
    sparse(join(dir, 'big.bin'), MAX_FILE_BYTES + 1)
    const env = gitEnv(dir)
    expect(env.readFile('msg.txt')).toBe('fix: x\n')
    expect(env.readFile('big.bin')).toBeNull()
    expect(env.readFile('.')).toBeNull()
    expect(env.readFile('missing.txt')).toBeNull()
    if (process.platform !== 'win32')
      expect(env.readFile('/dev/zero')).toBeNull()
  })

  it('tells a file that is not there from one that exists', () => {
    const dir = repo()
    writeFileSync(join(dir, 'msg.txt'), 'fix: x\n')
    const env = gitEnv(dir)
    expect(env.isMissing?.('nope.md')).toBe(true)
    expect(env.isMissing?.('msg.txt/inside')).toBe(true)
    expect(env.isMissing?.('msg.txt')).toBe(false)
    expect(env.isMissing?.('.')).toBe(false)
  })

  it('stops reading once the files read add up to more than a call may take', () => {
    const dir = repo()
    const size = MAX_FILE_BYTES / 2
    const names = Array.from({ length: MAX_READ_BYTES / size + 1 }, (_, i) => `part-${i}.bin`)
    for (const name of names)
      sparse(join(dir, name), size)
    const env = gitEnv(dir)
    const results = names.map(name => env.readFile(name))
    expect(results.slice(0, -1).every(text => text !== null)).toBe(true)
    expect(results.at(-1)).toBeNull()
    expect(env.readFile('part-0.bin')).toBeNull()
  })

  it('answers as the check that blocks once its time is up', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const dir = repo()
    writeFileSync(join(dir, '.env'), 'A=1\n')
    writeFileSync(join(dir, 'msg.txt'), 'fix: x\n')
    const env = gitEnv(dir)
    expect(env.isIgnored('.env')).toBe(true)
    expect(env.readFile('msg.txt')).toBe('fix: x\n')
    expect(env.listIgnored?.('.')).toEqual([join(dir, '.env')])
    vi.setSystemTime(Date.now() + TIME_BUDGET_MS + 1)
    expect(env.isIgnored('.env')).toBe(false)
    expect(env.readFile('msg.txt')).toBeNull()
    expect(env.listIgnored?.('.')).toBeNull()
  })
})
