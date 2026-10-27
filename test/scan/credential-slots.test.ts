import { describe, expect, it } from 'vitest'
import { findCredentialSlots } from '../../src'

const stand = (text: string): string[] => findCredentialSlots(text).map(slot => text.slice(slot.start, slot.end))

describe('findCredentialSlots: a slot for the user to type a secret into', () => {
  for (const [name, text] of [
    ['a bearer header', 'curl -H "Authorization: Bearer <YOUR_TOKEN>" https://api.github.com/user'],
    ['a basic header', `curl -H 'Authorization: Basic <base64 creds>' https://x.test`],
    ['an export', 'export OPENAI_API_KEY=your-api-key'],
    ['a .env line', 'STRIPE_SECRET_KEY=paste-here'],
    ['a flag with =', 'xurl auth --client-secret=<client secret>'],
    ['a flag with a space', 'vercel deploy --token <token>'],
    ['a bracketed stand-in', 'DB_PASSWORD=[password]'],
    ['an x-ed out value', 'GITHUB_TOKEN=xxxxxxxx'],
    ['a _HERE marker', 'SLACK_TOKEN=TOKEN_HERE'],
    ['a password in a URL', 'psql postgres://app:<password>@db.internal/app'],
    ['a YAML key', 'api_key: <your key>'],
    ['a JSON key', '{ "apiKey": "your-key" }'],
    ['an npmrc auth line', 'npm config set //registry.npmjs.org/:_authToken=<token>'],
    ['a quoted export', 'export DB_PASSWORD="changeme"'],
    ['a camel-cased secret key', 'secretKey: <your secret key>'],
  ]) {
    it(`finds ${name}`, () => {
      expect(findCredentialSlots(text!), text).not.toEqual([])
    })
  }

  for (const [name, text] of [
    ['a variable', 'curl -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/user'],
    ['a command substitution', 'curl -H "Authorization: Bearer $(gh auth token)" https://api.github.com/user'],
    ['a braced variable', 'export API_KEY=${API_KEY:-}'],
    ['an empty .env.example line', 'STRIPE_SECRET_KEY='],
    ['a slot for a non-secret', 'gcloud config set project <project-id>'],
    ['a generic type', 'const token: Promise<Token> = load()'],
    ['a prompted Keychain store', 'security add-generic-password -a "$USER" -s github -w'],
    ['a redirect pair after a secret-named flag', 'docker login --password-stdin < f > /dev/null'],
    ['a regex character class', `sed 's/[a-z0-9]//'`],
    ['a regex character class after a secret name', `rg 'TOKEN=[A-Z_]+' .env.example`],
    ['a character class in a sed over a password line', `sed -E 's/password=[a-z0-9]+//' log.txt`],
    ['a real-looking value, which is findSecrets\' job', 'export API_KEY=sk_live_abc'],
    ['a count of tokens', 'llm --max-tokens <N>'],
    ['a tokenizer path', 'train --tokenizer <path>'],
    ['a password file', 'mysql --password-file=<path>'],
    ['a token file', 'vault login --token-file <path>'],
    ['a secret id', 'aws secretsmanager get-secret-value --secret-id <secret-id>'],
    ['a credentials file path', 'export GOOGLE_APPLICATION_CREDENTIALS=<path/to/key.json>'],
    ['a token URL', 'TOKEN_URL=<url>'],
    ['a camel-cased token file', 'tokenFile: <file>'],
    ['a value already gone', 'password=<redacted> and api_key: <empty>'],
  ]) {
    it(`lets through ${name}`, () => {
      expect(findCredentialSlots(text!), text).toEqual([])
    })
  }

  it('spans the stand-in, names what it belongs to and previews it as written', () => {
    const text = 'export OPENAI_API_KEY="your-api-key" && curl -H "Authorization: Bearer <YOUR_TOKEN>" --client-secret <secret> postgres://app:<password>@db'
    const slots = findCredentialSlots(text)
    expect(slots.map(slot => text.slice(slot.start, slot.end))).toEqual(['your-api-key', '<YOUR_TOKEN>', '<secret>', '<password>'])
    expect(slots.map(slot => slot.name)).toEqual(['OPENAI_API_KEY', 'Authorization', '--client-secret', null])
    expect(slots.map(slot => slot.preview)).toEqual([
      'OPENAI_API_KEY="your-api-key',
      'Authorization: Bearer <YOUR_TOKEN>',
      '--client-secret <secret>',
      'app:<password>',
    ])
  })

  it('reports a slot that two shapes find once', () => {
    expect(stand('https://token:<token>@host')).toEqual(['<token>'])
  })

  it('cuts a long preview', () => {
    const [slot] = findCredentialSlots(`API_KEY=<${'a'.repeat(500)}>`)
    expect(slot!.preview.length).toBeLessThanOrEqual(80)
  })

  it('returns nothing for an empty or non-string input', () => {
    expect(findCredentialSlots('')).toEqual([])
    expect(findCredentialSlots(undefined as unknown as string)).toEqual([])
  })
})

describe('findCredentialSlots runs in linear time', () => {
  // The hook gets 10 seconds for the whole call, and a reply or command can be
  // as long as the agent likes.
  const within = (ms: number, text: string): void => {
    const started = performance.now()
    findCredentialSlots(text)
    expect(performance.now() - started, text.slice(0, 40)).toBeLessThan(ms)
  }

  it('on a header name followed by a long run of blanks', () => {
    within(500, `Authorization:${' '.repeat(200_000)}`)
    within(500, `Authorization: Bearer${' '.repeat(200_000)}x`)
  })

  it('on long runs of secret names and separators', () => {
    within(1000, 'token='.repeat(50_000))
    within(1000, 'token'.repeat(100_000))
    within(1000, `--token${' '.repeat(100_000)}`)
    within(1000, `${'a'.repeat(300_000)}token`)
    within(1000, 'token: '.repeat(50_000))
  })

  it('on long stand-in-looking values', () => {
    within(1000, `token=<${'a '.repeat(150_000)}`)
    within(1000, `token=[a${' a'.repeat(150_000)}`)
    within(1000, `token=${'a_'.repeat(150_000)}`)
    within(1000, 'token=<'.repeat(50_000))
    within(1000, 'token=['.repeat(50_000))
  })

  it('on a long run of URL schemes', () => {
    within(1000, '://a:'.repeat(60_000))
    within(1000, `://${'a'.repeat(300_000)}`)
  })
})
