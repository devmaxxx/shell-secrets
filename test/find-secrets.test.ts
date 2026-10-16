import { describe, expect, it } from 'vitest'
import { findNewSecrets, findSecrets } from '../src'
import { ALNUM, fake, p, rand, RULE_OF } from './fake'

const ids = (text: string): string[] => findSecrets(text).map(f => f.ruleId)

describe('recognising live secrets', () => {
  for (const [name, make] of Object.entries(fake)) {
    const rule = RULE_OF[name as keyof typeof fake]
    it(`finds a ${rule} (${name}) in running text`, () => {
      expect(ids(`here you go: ${make()} thanks`)).toEqual([rule])
    })
  }
})

describe('the shapes a secret takes outside a plain line of text', () => {
  it('finds a Telegram token inside the Bot API URL', () => {
    expect(ids(`https://api.telegram.org/bot${fake.telegram()}/getMe`)).toEqual(['telegram-bot-token'])
  })

  it('finds a private key pasted into a JSON string, newlines escaped as \\n', () => {
    const json = JSON.stringify({ private_key: fake.pem(), client_email: 'svc@example.org' })
    expect(ids(json)).toEqual(['private-key'])
  })

  it('finds a private key on one line of a shell or .env assignment', () => {
    expect(ids(`KEY="${fake.pem().replaceAll('\n', '\\n')}"`)).toEqual(['private-key'])
  })

  it('finds a passphrase-protected PEM key, whose header lines sit between the marker and the body', () => {
    const encrypted = p(
      '-----BEGIN ',
      'RSA PRIVATE',
      ' KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-256-CBC,',
      rand(32, '0123456789ABCDEF'),
      '\n\n',
      rand(64),
      '\n',
      rand(64),
      '\n-----END RSA PRIVATE KEY-----',
    )
    expect(ids(encrypted)).toEqual(['private-key'])
  })

  it('finds a PGP private key block', () => {
    const pgp = p(
      '-----BEGIN PGP ',
      'PRIVATE KEY',
      ' BLOCK-----\nVersion: GnuPG v2\n\n',
      rand(64),
      '\n',
      rand(64),
      '\n-----END PGP PRIVATE KEY BLOCK-----',
    )
    expect(ids(pgp)).toEqual(['private-key'])
  })

  it('finds the whole export block IAM Identity Center prints', () => {
    const block = [
      `export AWS_ACCESS_KEY_ID=${fake.awsTemporary()}`,
      `export ${p('AWS_SECRET', '_ACCESS_KEY=', rand(40, `${ALNUM}/+`))}`,
      `export ${fake.awsSessionToken()}`,
    ].join('\n')
    expect(ids(block)).toEqual(['aws-access-key', 'aws-secret-key', 'aws-secret-key'])
  })

  it('finds an AWS secret key in a JSON credentials file', () => {
    const json = JSON.stringify({ aws_secret_access_key: rand(40, `${ALNUM}/+`) })
    expect(ids(json)).toEqual(['aws-secret-key'])
  })

  it('finds a URI to a bracketed IPv6 host that is not loopback', () => {
    expect(ids(p('redis', '://default:', rand(20), '@[fd00::1]:6379'))).toEqual(['database-uri-password'])
  })
})

describe('letting placeholders and references through', () => {
  const benign: Record<string, string> = {
    'an x-ed out GitHub token': p('gh', 'p_', 'x'.repeat(36)),
    'a token marked as an example': p('sk', '-ant-', 'example', rand(30)),
    'a low-variety stand-in': p('gh', 'p_', 'abc'.repeat(12)),
    'an AWS doc key with EXAMPLE': p('AK', 'IA', 'IOSFODNN7EXAMPLE'),
    'a PEM header with no body': p('-----BEGIN ', 'PRIVATE', ' KEY-----\n...\n-----END PRIVATE KEY-----'),
    'a URI whose password is a variable': 'postgres://app:${PG_PASSWORD}@db.prod:5432/app',
    'a URI whose password is a variable with a default': 'postgres://app:${PG_PASSWORD:-changeit}@db.prod:5432/app',
    'a URI built from process.env': 'postgres://app:${process.env.PG_PASSWORD}@db.prod:5432/app',
    'a URI whose user and password are both variables': 'postgres://${PG_USER}:${PG_PASSWORD}@db.prod:5432/app',
    'a URI with the user as password': 'postgres://postgres:postgres@db:5432/app',
    'a URI to localhost': p('mongodb', '://root:', rand(16), '@localhost:27017'),
    'a URI to the IPv6 loopback': p('redis', '://default:', rand(16), '@[::1]:6379'),
    'a URI with a starred password': 'redis://default:****@cache.prod:6379',
    'a URI with <password>': 'mongodb+srv://app:<password>@cluster0.mongodb.net',
    'a URI with no password': 'postgres://app@db.prod:5432/app',
    'a short JWT sample': p('ey', 'J', rand(12), '.ey', 'J', rand(12), '.', rand(22)),
    'a timestamp-ish ratio': '12345678:not-a-token',
    'a word that ends in sk-': 'the task-runner-for-everything-in-the-repository-and-more ran',
    'a prose mention of the prefixes': 'GitHub tokens start with ghp_ and Slack ones with xoxb-',
    'the AWS doc secret key': p('aws_secret', '_access_key=', 'wJalrXUtnFEMI', '/K7MDENG/', 'bPxRfiCY', 'EXAMPLEKEY'),
    'an AWS secret key read from a variable': 'export AWS_SECRET_ACCESS_KEY=$(op read op://vault/aws/secret)',
    'an AWS secret key from a CI secret': 'AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}',
    'the Slack doc webhook': p('https://hooks', '.slack.com/services/T', '0'.repeat(9), '/B', '0'.repeat(9), '/', 'X'.repeat(24)),
    'a PGP public key block': p('-----BEGIN PGP ', 'PUBLIC KEY', ' BLOCK-----\n\n', rand(64), '\n-----END PGP PUBLIC KEY BLOCK-----'),
    'a RabbitMQ guest URI': 'amqp://guest:guest@rabbitmq:5672',
    'a query password that is a variable': 'postgres://db.prod/app?user=app&password=${DB_PASSWORD}',
    'a query password that is a dev default': 'postgres://localhost/app?user=app&password=postgres',
    'an ordinary sentence that names a variable': 'read the token from $GITHUB_TOKEN and open a PR',
    'code that reads the variable': 'const t = process.env.GITHUB_TOKEN;',
  }
  for (const [name, text] of Object.entries(benign)) {
    it(`ignores ${name}`, () => {
      expect(findSecrets(text)).toEqual([])
    })
  }

  // The remainder is random, so only the marker itself can mark the stand-in.
  const MARKERS = [
    'xxxx',
    'example',
    'placeholder',
    'redacted',
    'dummy',
    'fake',
    'sample',
    'your',
    'changeme',
    'replaceme',
    '00000000',
    '1234567',
  ]
  for (const marker of MARKERS) {
    it(`ignores a token whose body carries "${marker}"`, () => {
      expect(findSecrets(p('gh', 'p_', marker, rand(36 - marker.length)))).toEqual([])
    })
  }

  it('ignores a lowercase slug that starts like an OpenAI key', () => {
    expect(findSecrets('class sk-skeleton-loader-for-the-dashboard-card-component')).toEqual([])
  })
})

describe('a long value is judged by its start, and in linear time', () => {
  const pem = (body: string): string =>
    p('-----BEGIN ', 'RSA PRIVATE', ' KEY-----\n', body, '\n-----END RSA PRIVATE KEY-----')

  it('still finds a key whose body spells a marker by chance, deep inside', () => {
    expect(ids(pem(p(rand(200), 'xxxx', rand(900))))).toEqual(['private-key'])
  })

  it('still reads a key whose body opens with a marker as a stand-in', () => {
    expect(findSecrets(pem(p('example', rand(70), '\n', rand(64))))).toEqual([])
  })

  // Scanners run on every keystroke, prompt or commit; a pathological input must not stall them.
  const within = (ms: number, text: string): void => {
    const started = performance.now()
    findSecrets(text)
    expect(performance.now() - started).toBeLessThan(ms)
  }

  it('scans a password that is a long run of angle brackets in linear time', () => {
    within(2000, p('redis', '://u:', '<'.repeat(200_000), '@h'))
  })

  it('scans a long run of unclosed ${ in linear time', () => {
    within(2000, p('postgres', '://a:', '${'.repeat(80_000), '@h'))
  })

  it('scans a long run of header-looking lines after a key marker in linear time', () => {
    within(2000, p('-----BEGIN ', 'PRIVATE', ' KEY-----\n', 'A-b: c\n'.repeat(60_000)))
  })

  it('scans a long unterminated header line after a key marker in linear time', () => {
    within(2000, p('-----BEGIN ', 'PRIVATE', ' KEY-----\nA: ', 'b'.repeat(300_000)))
  })

  it('scans a one-line run of JSON-escaped key markers in linear time', () => {
    within(2000, p('-----BEGIN ', 'PRIVATE', ' KEY-----\\nA: b').repeat(20_000))
  })

  it('scans a long run of schemes that never reach a password in linear time', () => {
    within(2000, 'postgres://x?'.repeat(20_000))
  })
})

describe('findNewSecrets: a secret the earlier text already holds', () => {
  const token = fake.github()

  it('is not reported when an edit keeps it as context', () => {
    expect(findNewSecrets(`TOKEN=${token}\nTTL=1`, `TOKEN=${token}\nTTL=2`)).toEqual([])
  })

  it('does not hide a second secret added beside it', () => {
    const added = findNewSecrets(`TOKEN=${token}`, `TOKEN=${token}\nOTHER=${fake.figma()}`)
    expect(added.map(f => f.ruleId)).toEqual(['figma-token'])
  })

  it('does not hide a different secret of the same kind swapped in', () => {
    const swapped = findNewSecrets(`TOKEN=${token}`, `TOKEN=${fake.github()}`)
    expect(swapped.map(f => f.ruleId)).toEqual(['github-token'])
  })

  it('reports everything when the earlier text is empty', () => {
    expect(findNewSecrets('', `TOKEN=${token}\n`).map(f => f.ruleId)).toEqual(['github-token'])
  })
})
