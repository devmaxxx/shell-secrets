import type { Rule } from '../src'
import { describe, expect, it } from 'vitest'
import { defaultRules, findSecrets } from '../src'
import { fake, p, rand } from './fake'

describe('a finding locates the secret without carrying it', () => {
  it('spans exactly the token in running text', () => {
    const token = fake.github()
    const text = `use ${token} please`
    const [finding] = findSecrets(text)
    expect(finding).toMatchObject({ ruleId: 'github-token', name: 'GitHub token', env: 'GITHUB_TOKEN' })
    expect(text.slice(finding!.start, finding!.end)).toBe(token)
  })

  it('spans only the password of a URI, not its user or host', () => {
    const password = rand(18)
    const text = p('postgres', 'ql://svc:', password, '@db.prod.internal:5432/app')
    const [finding] = findSecrets(text)
    expect(text.slice(finding!.start, finding!.end)).toBe(password)
  })

  it('keeps offsets right when a template variable precedes the password', () => {
    const password = rand(18)
    const text = p('note ${A} then postgres', '://${PG_USER}:', password, '@db.prod.internal/app')
    const [finding] = findSecrets(text)
    expect(text.slice(finding!.start, finding!.end)).toBe(password)
  })

  it('spans only the value of a named AWS secret key, and the part after the colon of a Telegram token', () => {
    const secret = rand(40)
    const bot = rand(10, '123456789')
    const tail = p('AA', rand(33))
    const text = `AWS_SECRET_ACCESS_KEY=${secret}\nbot${bot}:${tail}`
    expect(findSecrets(text).map(f => text.slice(f.start, f.end))).toEqual([secret, tail])
  })

  it('previews a long token by its first four characters and never its value', () => {
    const token = fake.github()
    const [finding] = findSecrets(`t=${token}`)
    expect(finding!.preview).toBe(`${token.slice(0, 4)}********`)
    expect(JSON.stringify(finding)).not.toContain(token.slice(4))
  })

  it('previews a short password with nothing of it', () => {
    const [finding] = findSecrets(p('redis', '://default:', rand(16), '@cache.prod.internal'))
    expect(finding!.preview).toBe('********')
  })

  it('orders findings by position, not by rule', () => {
    const text = `${fake.jwt()} ${fake.figma()} ${fake.github()}`
    expect(findSecrets(text).map(f => f.ruleId)).toEqual(['jwt', 'figma-token', 'github-token'])
  })

  it('returns nothing for an empty or non-string input', () => {
    expect(findSecrets('')).toEqual([])
    expect(findSecrets(undefined as unknown as string)).toEqual([])
  })
})

describe('the rule list', () => {
  it('gives every built-in rule a unique kebab-case id', () => {
    const ids = defaultRules.map(r => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    }
  })

  it('disables a rule when it is filtered out', () => {
    const text = `${fake.jwt()} ${fake.github()}`
    const rules = defaultRules.filter(r => r.id !== 'jwt')
    expect(findSecrets(text, { rules }).map(f => f.ruleId)).toEqual(['github-token'])
  })

  it('runs a custom rule written without the g flag, with its own placeholder test', () => {
    const acme: Rule = {
      id: 'acme-key',
      name: 'Acme API key',
      env: 'ACME_KEY',
      pattern: /acme_live_([A-Za-z0-9]{24})/,
      secretGroup: 1,
    }
    const key = rand(24)
    const text = `a=acme_live_${key} b=acme_live_${'x'.repeat(24)} c=acme_live_${rand(24)}`
    const found = findSecrets(text, { rules: [...defaultRules, acme] })
    expect(found.map(f => f.ruleId)).toEqual(['acme-key', 'acme-key'])
    expect(text.slice(found[0]!.start, found[0]!.end)).toBe(key)
  })

  it('refuses a prepare step that changes the text length, since offsets would lie', () => {
    const broken: Rule = { id: 'broken', name: 'broken', env: null, pattern: /z/, prepare: t => `${t}!` }
    expect(() => findSecrets('abc', { rules: [broken] })).toThrow(/broken/)
  })
})
