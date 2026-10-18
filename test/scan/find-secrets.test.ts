import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { findNewSecrets, findSecrets } from '../../src'
import { ALNUM, fake, p, rand, RULE_OF } from '../support/fake'

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
    'a Stripe test-mode key': p('sk', '_test_', rand(99)),
    'an x-ed out Stripe key': p('sk', '_live_', 'x'.repeat(24)),
    'a Google key marked as yours': p('AI', 'za', 'Sy-your-api-key-goes-here-123456789'),
    'an npm token of zeros': p('np', 'm_', '0'.repeat(36)),
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

  it('scans a long run of assignments, and a long blob after one, in linear time', () => {
    within(2000, 'a='.repeat(100_000))
    within(2000, `=${'A'.repeat(31)}`.repeat(20_000))
    within(2000, `KEY=${'QUFB'.repeat(50_000)}`)
  })

  it('scans a long run of schemes that never reach a password in linear time', () => {
    within(2000, 'postgres://x?'.repeat(20_000))
  })
})

describe('telling a real token from a made-up one', () => {
  it('ignores a classic GitHub token whose checksum does not add up, as in docs and tests', () => {
    const real = fake.github()
    expect(ids(real)).toEqual(['github-token'])
    expect(ids(p(real.slice(0, -6), rand(6)))).toEqual([])
  })

  it('ignores a 1Password token whose body is not base64 JSON', () => {
    expect(ids(p('op', 's_', 'eyJ', rand(120)))).toEqual([])
  })

  it('reports a token once, under its provider, when a generic rule matches it too', () => {
    expect(ids(`GITHUB_TOKEN=${fake.github()}`)).toEqual(['github-token'])
    expect(ids(`git clone https://x-access-token:${fake.github()}@github.com/o/r`)).toEqual(['github-token'])
    expect(ids(fake.postgresQuery())).toEqual(['database-uri-query-password'])
  })
})

describe('a secret behind base64', () => {
  const b64 = (text: string): string => btoa(text)

  it('finds a token in a Kubernetes Secret value and spans the encoded text', () => {
    const encoded = b64(fake.github())
    const manifest = `kind: Secret\ndata:\n  token: ${encoded}\n`
    const [finding] = findSecrets(manifest)
    expect(finding).toMatchObject({ ruleId: 'github-token', name: 'GitHub token, base64-encoded', start: manifest.indexOf(encoded) })
    expect(finding!.end - finding!.start).toBe(encoded.length)
  })

  it('finds one decoded twice, and one in a base64 -d pipeline', () => {
    expect(ids(b64(b64(`AWS key ${fake.aws()}`)))).toEqual(['aws-access-key'])
    expect(ids(`echo ${b64(`export T=${fake.anthropic()}`)} | base64 -d >> ~/.zshrc`)).toEqual(['anthropic-api-key'])
  })

  it('decodes a blob assigned with =, as in an .env file, a flag or a query string', () => {
    const encoded = b64(`T ${fake.github()}`)
    expect(ids(`DATA=${encoded}`)).toEqual(['github-token'])
    expect(ids(`deploy --payload=${encoded}`)).toEqual(['github-token'])
    expect(ids(`https://hooks.internal.io/in?d=${encoded}`)).toEqual(['github-token'])
  })

  it('previews a secret encoded twice by the secret, not by the layer between', () => {
    const token = fake.github()
    expect(findSecrets(b64(b64(token)))[0]!.preview).toBe(`${token.slice(0, 4)}********`)
    const short = p('redis', '://default:', rand(16), '@cache.prod.internal')
    expect(findSecrets(b64(b64(short)))[0]!.preview).toBe('********')
  })

  it('passes over a blob that decodes to binary or to clean text', () => {
    expect(ids(`integrity: sha512-${rand(86, `${ALNUM}+/`)}==`)).toEqual([])
    expect(ids(b64('just an ordinary sentence with nothing secret in it'))).toEqual([])
  })

  it('decodes a long run of base64 in linear time', () => {
    const started = performance.now()
    findSecrets('QUFB'.repeat(100_000))
    findSecrets(b64(b64(b64('x'.repeat(100_000)))))
    expect(performance.now() - started).toBeLessThan(2000)
  })
})

describe('a secret-named value that is not a secret', () => {
  const cases: Record<string, string> = {
    'a passphrase of words': 'password = "correcthorsebatterystaple"',
    'a function name': 'api_key: getApiKeyFromVault',
    'a record id under a token name': '{"token_id": "3f2504e0-4f89-11d3-9a0c-0305e82c3301"}',
    'a type name': 'credentialId: Base64URLString;',
    'a file path': 'SECRET_KEY_FILE=./secrets/signing-key.pem',
    'a member path': 'token: process.env.GITHUB_TOKEN',
    'a run of the alphabet': 'token: 0123456789abcdef0123',
    'a variable': 'deploy --token $GITHUB_TOKEN',
    'a constant name': 'TOKEN_KIND=PERSONAL_ACCESS_TOKEN',
    'a bearer variable': 'curl -H "Authorization: Bearer $TOKEN" https://api.io',
    'a bearer placeholder': 'curl -H "Authorization: Bearer <your-token-here>" https://api.io',
    'a loopback URL': 'https://user:hunter22@localhost:8080',
    'a URL password from a variable': 'https://deploy:${REGISTRY_PASSWORD}@registry.internal.io',
    'a curl password from variables': 'curl -u "$USER:$PASS" https://api.io',
    'a uid:gid pair': 'docker run -u 1000:2000 node',
    'a URL to a reserved documentation host': 'https://deploy:s3cr3tvalue@registry.example.com',
    'a classic stand-in password': 'https://alice:hunter2@db.internal.io',
    'a digest of a secret': `"hashed_secret": "${rand(40, '0123456789abcdef')}"`,
    'a digest named by its suffix': `token_sha256 = "${rand(64, '0123456789abcdef')}"`,
    'a public key': `stripe_publishable_key: ${rand(32)}`,
    'a file named after a token': `"cloudflare_api_token.go": "${rand(64, '0123456789abcdef')}"`,
  }
  for (const [name, text] of Object.entries(cases)) {
    it(`ignores ${name}`, () => {
      expect(ids(text)).toEqual([])
    })
  }

  it('judges a base64 value by the text it encodes', () => {
    const encoded = (text: string): string => Buffer.from(text).toString('base64')
    expect(ids(`CLOCKIFY_API_KEY = "${encoded(crypto.randomUUID())}"`)).toEqual(['generic-secret'])
    expect(ids(`API_KEY=${encoded(rand(32, '0123456789abcdef'))}`)).toEqual(['generic-secret'])
    expect(ids(`session_id = "${encoded(crypto.randomUUID())}"`)).toEqual([])
  })

  it('reads the punctuation password generators emit as part of a generic value', () => {
    expect(ids(`db_password = "${rand(6)}&${rand(5)}?${rand(5)}$${rand(4)}|${rand(4)}:x"`)).toEqual(['generic-secret'])
  })

  it('still reports the shapes a filter could mistake for one of these', () => {
    const value = rand(28)
    expect(ids(`https://ci:${value}@nexus:8081/repo`)).toEqual(['url-password'])
    expect(ids(`HEROKU_API_KEY=${rand(8, '0123456789abcdef')}-${rand(4, '0123456789abcdef')}-4${rand(3, '0123456789abcdef')}-a${rand(3, '0123456789abcdef')}-${rand(12, '0123456789abcdef')}`)).toEqual(['generic-secret'])
    expect(ids(`db_password = "/${value}"`)).toEqual(['generic-secret'])
    expect(ids(`hashicorp_vault_token = "${value}"`)).toEqual(['generic-secret'])
    expect(ids(`config.token = "${value}"`)).toEqual(['generic-secret'])
    expect(ids(`{"auth.token": "${value}"}`)).toEqual(['generic-secret'])
    expect(ids(`db.pwd = "${value}"`)).toEqual(['generic-secret'])
    expect(ids(`HASH_SECRET=${value}`)).toEqual(['generic-secret'])
    expect(ids(`PUBLIC_SECRET=${value}`)).toEqual(['generic-secret'])
    expect(ids(`API.KEY=${value}`)).toEqual(['generic-secret'])
    expect(ids(`token.value = "${value}"`)).toEqual(['generic-secret'])
    expect(ids(`"api.key": "${value}"`)).toEqual(['generic-secret'])
    expect(ids(`API_KEY=${'q8Zr3LmVbN'}.Tw7xKd2pYs`)).toEqual(['generic-secret'])
    expect(ids(`headers['Authorization'] = 'Bearer ${value}'`)).toEqual(['authorization-header'])
    expect(ids(`curl -su deploy:${value} https://api.internal.io`)).toEqual(['curl-user-password'])
    expect(ids(`password=${value.slice(0, 6)}!${value.slice(6, 12)}#${value.slice(12)}`)).toEqual(['generic-secret'])
  })

  it('keeps hundreds of thousands of findings without overflowing the stack', () => {
    const line = `API_TOKEN=${rand(32)}\n`
    expect(findSecrets(line.repeat(150_000))).toHaveLength(150_000)
  }, 30_000)

  it('scans a long run of secret names in linear time', () => {
    const started = performance.now()
    findSecrets('token='.repeat(30_000))
    findSecrets(p('--token', '-'.repeat(100_000), ' x'))
    findSecrets(p('curl ', '-u '.repeat(50_000)))
    expect(performance.now() - started).toBeLessThan(2000)
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

  it('is not reported when its line moves, its key is renamed or a second copy appears', () => {
    expect(findNewSecrets(`A=${token}\nB=1`, `B=1\nA=${token}`)).toEqual([])
    expect(findNewSecrets(`A=${token}`, `B="${token}"`)).toEqual([])
    expect(findNewSecrets(`A=${token}`, `A=${token}\nB=${token}`)).toEqual([])
  })

  it('does not hide a secret the edit extends past the one already there', () => {
    expect(findNewSecrets(`A=${token}`, `A=${token}Zq9`).map(f => f.ruleId)).toEqual(['github-token'])
  })

  it('reports everything when the earlier text is empty', () => {
    expect(findNewSecrets('', `TOKEN=${token}\n`).map(f => f.ruleId)).toEqual(['github-token'])
  })
})

describe('the end of a token at the end of a sentence', () => {
  it('leaves a sentence-final dot out of a GitLab token', () => {
    const token = fake.gitlab()
    const [finding] = findSecrets(`rotate ${token}.`)
    expect(finding?.end).toBe('rotate '.length + token.length)
  })
})
