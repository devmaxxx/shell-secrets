import type { Rule } from './types'
import { hasMarker, VARIABLE } from './placeholder'
import { hasGitHubChecksum, isRandom } from './random'

const BOUNDARY_BEFORE = '(?<![A-Za-z0-9_-])'
const BOUNDARY_AFTER = '(?![A-Za-z0-9_-])'

function bounded(body: string): RegExp {
  return new RegExp(`${BOUNDARY_BEFORE}${body}${BOUNDARY_AFTER}`, 'g')
}

// `${PW:-default}` and `${process.env.PW}` hold colons and dots of their own,
// which would split a URI's user from its password in the wrong place. The cap
// keeps a run of unclosed `${` linear instead of quadratic.
function withoutTemplates(text: string): string {
  return text.replace(/\$\{[^}\s]{0,100}\}/g, template => `$${'V'.repeat(template.length - 1)}`)
}

const DEV_HOSTS = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/
const DEV_PASSWORDS
  = /^(?:pass(?:word)?|pwd|secret|token|hunter2|postgres|mongo|redis|root|admin|test|user)$/i

/**
 * Compose files and local READMEs are full of `postgres:postgres@localhost`;
 * flagging those would train everyone to ignore the scanner.
 */
function isDevCredential(user: string, password: string, host: string): boolean {
  return (
    VARIABLE.test(password)
    || hasMarker(password)
    || password === user
    || DEV_PASSWORDS.test(password)
    || DEV_HOSTS.test(host)
  )
}

// Names RFC 2606 reserves for documentation and tests, which never resolve.
const RESERVED_HOST = /(?:^|\.)(?:example\.(?:com|net|org)|[^.]+\.(?:example|invalid|test|localhost))$/i

// A URL's password is checked like a database URI's, and must be long enough
// not to be a hand-typed stand-in.
function isPlaceholderUrlCredential(user: string, password: string, host: string): boolean {
  return (
    isDevCredential(user, password, host)
    || password.length < 4
    || /^(.)\1*$/.test(password)
    || RESERVED_HOST.test(host)
  )
}

const SEQUENCES = (() => {
  const digits = '0123456789'
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  const runs = [`${upper}${upper.toLowerCase()}${digits}+/`, `${digits}${upper}`, '0123456789ABCDEF', `${upper}=/`]
  return [...runs, ...runs.map(run => [...run].reverse().join(''))].map(run => (run + run).toUpperCase())
})()
// A UUID under a secret's name is a key (Heroku issues them so). Hex with
// dashes reads as low-variety to the randomness test, so it is let through
// on its shape.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MEMBER_PATH = /^[A-Z_$][\w$]*(?:\.[A-Z_$][\w$]*)+$/i
// `q8Zr3LmVbN.Tw7xKd2pYs` has the shape of a path too; a part with digits past
// a short `v2` or `s3` reads as random, not as a property name.
const isMemberPath = (value: string): boolean => MEMBER_PATH.test(value) && value.split('.').every(part => part.length <= 4 || !/\d/.test(part))
// A bare leading `/` is left out: one random base64 value in 64 starts with it.
const FILE_PATH = /^(?:\.{1,2}\/|~\/|[A-Z]:\\)/i
// A type or class name built of words, with digits that get it past the
// randomness test. A random key falls into this shape about once in 4000.
const WORD = /[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g
function isIdentifier(value: string): boolean {
  const words = value.match(WORD) ?? []
  return words.join('') === value
    && words.every(word => /^(?:[A-Z]?[a-z]{3,}|[A-Z]{2,}|\d{1,3})$/.test(word))
    && words.filter(word => /^[A-Z][a-z]/.test(word)).length >= 2
}

// A digest of a secret (`hashed_secret`, `token_sha256`), a public key, or a
// file named after one (`token.go`) is not the secret itself. A word only
// counts in the place it names something else: `hash_secret` and
// `public_secret` are secrets, `api.key` is no file, and `hashicorp_vault_token`
// is a token.
const NOT_A_SECRET_NAME = /(?:^|_)(?:hashed|digest|checksum|fingerprint)(?:_|$)|_(?:hash|sha\d*)$|(?:^|_)(?:public|publishable)_key$/
const FILE_NAME = /\.(?:go|[cm]?[jt]sx?|py|rb|rs|java|kt|php|cs|swift|[ch](?:pp)?|json|ya?ml|toml|ini|env|pem|crt|txt|md|sh|cfg|conf|xml|tf)$/

const snakeCase = (name: string): string => name.replace(/["'\]\s:=<>-]+$/, '').replace(/([a-z\d])([A-Z])/g, '$1_$2').toLowerCase()

/** The matched name up to its value, from the secret word on: `token.go`, not `config.token`. */
const keyOf = (match: RegExpExecArray): string => snakeCase(match[0].slice(0, match[0].length - (match[1]?.length ?? 0)))

/** The variable's whole name: the word joined to the match, then the match up to its value. */
function nameOf(match: RegExpExecArray): string {
  const before = match.input.slice(Math.max(0, match.index - 40), match.index).match(/[\w.-]*$/)?.[0] ?? ''
  return snakeCase(before) + keyOf(match)
}

function isNotASecretName(match: RegExpExecArray): boolean {
  return FILE_NAME.test(keyOf(match)) || NOT_A_SECRET_NAME.test(nameOf(match).replace(/[.-]/g, '_'))
}

// `token_id` names a token; the UUID under it is a record's id, not a key.
const ID_NAME = /(?:^|_)(?:id|uuid|guid)$/

/**
 * A value under a secret-sounding name is reported only when it reads as
 * machine-generated. Names, paths (`process.env.TOKEN`, `./key.pem`) and runs
 * of the alphabet are not, whatever they are called. The cheap shape checks
 * run before the randomness test.
 */
function isGenericNonSecret(value: string, name: string): boolean {
  if (UUID.test(value))
    return ID_NAME.test(name)
  return (
    isMemberPath(value)
    || isIdentifier(value)
    || FILE_PATH.test(value)
    || SEQUENCES.some(run => run.includes(value.toUpperCase()))
    || !isRandom(value)
  )
}

function isJsonInBase64(body: string): boolean {
  try {
    const json = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/')))
    return typeof json === 'object' && json !== null
  }
  catch {
    return false
  }
}

const SECRET_NAME = '(?:(?:api|access|auth|client|private|secret|signing|encryption|master|app|service)[_.-]?key|token|secret|passw(?:or)?d|pwd|credential)'

/** The built-in rules, in the order they run. */
export const defaultRules: readonly Rule[] = Object.freeze([
  {
    id: 'github-token',
    name: 'GitHub token',
    env: 'GITHUB_TOKEN',
    pattern: bounded('gh[pousr]_[A-Za-z0-9]{36,}'),
    ignore: match => match[0].length === 40 && !hasGitHubChecksum(match[0]),
  },
  {
    id: 'github-fine-grained-token',
    name: 'GitHub fine-grained token',
    env: 'GITHUB_TOKEN',
    pattern: bounded('github_pat_[A-Za-z0-9_]{40,}'),
  },
  {
    id: 'atlassian-api-token',
    name: 'Atlassian API token',
    env: 'ATLASSIAN_API_TOKEN',
    // ATATT3 is a user API token, ATCTT3 a Bitbucket repository or workspace access token.
    pattern: bounded('AT(?:ATT|CTT)3[A-Za-z0-9_=-]{30,}'),
  },
  {
    id: 'figma-token',
    name: 'Figma token',
    env: 'FIGMA_TOKEN',
    pattern: bounded('figd_[A-Za-z0-9_-]{30,}'),
  },
  {
    id: 'slack-token',
    name: 'Slack token',
    env: 'SLACK_TOKEN',
    pattern: bounded('(?:xox[abpre]|xapp)-[A-Za-z0-9-]{20,}'),
  },
  {
    id: 'slack-webhook-url',
    name: 'Slack webhook URL',
    env: 'SLACK_WEBHOOK_URL',
    pattern: bounded('https://hooks\\.slack\\.com/services/T[A-Z0-9]{8,}/B[A-Z0-9]{8,}/[A-Za-z0-9]{20,}'),
  },
  {
    id: 'anthropic-api-key',
    name: 'Anthropic API key',
    env: 'ANTHROPIC_API_KEY',
    pattern: bounded('sk-ant-[A-Za-z0-9_-]{30,}'),
  },
  {
    id: 'openai-api-key',
    name: 'OpenAI API key',
    env: 'OPENAI_API_KEY',
    pattern: bounded('sk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}'),
  },
  {
    id: 'google-api-key',
    name: 'Google API key',
    env: 'GOOGLE_API_KEY',
    // Gemini, Maps and Firebase keys share this shape.
    pattern: bounded('AIza[A-Za-z0-9_-]{35}'),
  },
  {
    id: 'google-oauth-client-secret',
    name: 'Google OAuth client secret',
    env: 'GOOGLE_CLIENT_SECRET',
    pattern: bounded('GOCSPX-[A-Za-z0-9_-]{28}'),
  },
  {
    id: 'groq-api-key',
    name: 'Groq API key',
    env: 'GROQ_API_KEY',
    pattern: bounded('gsk_[A-Za-z0-9]{48,}'),
  },
  {
    id: 'xai-api-key',
    name: 'xAI API key',
    env: 'XAI_API_KEY',
    pattern: bounded('xai-[A-Za-z0-9]{70,}'),
  },
  {
    id: 'huggingface-token',
    name: 'Hugging Face token',
    env: 'HF_TOKEN',
    pattern: bounded('hf_[A-Za-z0-9]{34,}'),
  },
  {
    id: 'gitlab-token',
    name: 'GitLab token',
    env: 'GITLAB_TOKEN',
    // Personal, deploy, pipeline-trigger, runner and OAuth tokens. Newer ones
    // are routable and carry dot-separated parts after the random body.
    pattern: bounded('gl(?:pat|dt|ptt|rt|oas)-[A-Za-z0-9_-]{20,}(?:\\.[A-Za-z0-9_-]+)*'),
  },
  {
    id: 'npm-token',
    name: 'npm token',
    env: 'NPM_TOKEN',
    pattern: bounded('npm_[A-Za-z0-9]{36}'),
  },
  {
    id: 'pypi-token',
    name: 'PyPI token',
    env: 'PYPI_API_TOKEN',
    // Every PyPI macaroon opens with the base64 of its `pypi.org` location.
    pattern: bounded('pypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}'),
  },
  {
    id: 'stripe-secret-key',
    name: 'Stripe secret key',
    env: 'STRIPE_SECRET_KEY',
    // Test-mode keys reach no real money or customer data, so only live ones count.
    pattern: bounded('(?:sk|rk)_live_[A-Za-z0-9]{24,}'),
  },
  {
    id: 'stripe-webhook-secret',
    name: 'Stripe webhook secret',
    env: 'STRIPE_WEBHOOK_SECRET',
    pattern: bounded('whsec_[A-Za-z0-9]{32,}'),
  },
  {
    id: 'sendgrid-api-key',
    name: 'SendGrid API key',
    env: 'SENDGRID_API_KEY',
    pattern: bounded('SG\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{43}'),
  },
  {
    id: 'linear-api-key',
    name: 'Linear API key',
    env: 'LINEAR_API_KEY',
    pattern: bounded('lin_api_[A-Za-z0-9]{40}'),
  },
  {
    id: 'shopify-token',
    name: 'Shopify token',
    env: 'SHOPIFY_ACCESS_TOKEN',
    pattern: bounded('shp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}'),
  },
  {
    id: 'digitalocean-token',
    name: 'DigitalOcean token',
    env: 'DIGITALOCEAN_TOKEN',
    pattern: bounded('do[opr]_v1_[a-f0-9]{64}'),
  },
  {
    id: 'discord-webhook-url',
    name: 'Discord webhook URL',
    env: 'DISCORD_WEBHOOK_URL',
    pattern: bounded('https://(?:ptb\\.|canary\\.)?discord(?:app)?\\.com/api/webhooks/\\d{17,20}/[A-Za-z0-9_-]{60,}'),
  },
  {
    id: 'aws-access-key',
    name: 'AWS access key',
    env: 'AWS_ACCESS_KEY_ID',
    // ASIA is the temporary key ID that STS and SSO hand out.
    pattern: bounded('(?:AKIA|ASIA)[0-9A-Z]{16}'),
  },
  {
    id: 'aws-secret-key',
    name: 'AWS secret key',
    env: 'AWS_SECRET_ACCESS_KEY',
    // The secret half has no prefix to recognise, so it is read off its name.
    pattern: /aws_?(?:secret_?access_?key|session_?token)["']?\s*[:=]\s*["']?([a-z0-9/+=]{40,})(?![a-z0-9/+=])/gi,
    secretGroup: 1,
  },
  {
    id: 'private-key',
    name: 'private key',
    env: null,
    // The header alone is how docs show the format; a key has a body. A key in
    // a JSON string (a service-account file) has `\n` escapes, not newlines, and
    // an encrypted or PGP one puts `Name: value` lines between header and body.
    // Those lines are capped in number and length: unbounded, a run of markers
    // would each walk the rest of the text.
    pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----(?:\s|\\n)+(?:[A-Za-z][A-Za-z-]{0,30}: [^\n\\]{0,200}(?:\n|\\n)(?:\s|\\n)*){0,8}((?:[A-Za-z0-9+/=\s]|\\n){64,})/g,
    secretGroup: 1,
  },
  {
    id: 'age-secret-key',
    name: 'age secret key',
    env: null,
    pattern: bounded('AGE-SECRET-KEY-1[02-9AC-HJ-NP-Z]{58}'),
  },
  {
    id: 'database-uri-password',
    name: 'database URI with an inline password',
    env: 'DATABASE_URL',
    // The user may be empty (`redis://:password@host`), the host may be a
    // bracketed IPv6 literal, and a driver may follow the scheme
    // (`postgresql+asyncpg`).
    pattern: /\b(?:mongodb|postgres(?:ql)?|mysql|mariadb|rediss?|amqps?)(?:\+[a-z0-9_]+)?:\/\/([^:/\s@]*):([^@\s/]+)@(\[[^\]\s]*\]|[^\s/:?#]+)/g,
    prepare: withoutTemplates,
    secretGroup: 2,
    ignore: match => isDevCredential(match[1] ?? '', match[2] ?? '', match[3] ?? ''),
    placeholders: false,
  },
  {
    id: 'database-uri-query-password',
    name: 'database URI with an inline password',
    env: 'DATABASE_URL',
    // libpq and JDBC URIs carry the password as a query parameter. The span
    // before it is capped so that a long run of schemes stays linear.
    pattern: /\b(?:postgres(?:ql)?|mysql|mariadb|sqlserver|mongodb(?:\+srv)?):\/\/[^\s'"`]{0,200}?[?&;]password=([^&\s;'"`]+)/gi,
    prepare: withoutTemplates,
    secretGroup: 1,
    ignore: match => VARIABLE.test(match[1] ?? '') || DEV_PASSWORDS.test(match[1] ?? ''),
  },
  {
    id: 'sentry-token',
    name: 'Sentry token',
    env: 'SENTRY_AUTH_TOKEN',
    pattern: bounded('(?:sntrys_eyJ[A-Za-z0-9+/=_-]{80,}|sntryu_[a-f0-9]{64})'),
  },
  {
    id: 'databricks-token',
    name: 'Databricks token',
    env: 'DATABRICKS_TOKEN',
    pattern: bounded('dapi[a-f0-9]{32}(?:-\\d+)?'),
  },
  {
    id: 'onepassword-service-account-token',
    name: '1Password service account token',
    env: 'OP_SERVICE_ACCOUNT_TOKEN',
    // The body is base64 JSON; one that does not decode is a made-up value.
    pattern: bounded('ops_(eyJ[A-Za-z0-9+/=_-]{100,})'),
    ignore: match => !isJsonInBase64(match[1] ?? ''),
  },
  {
    id: 'telegram-bot-token',
    name: 'Telegram bot token',
    env: 'TELEGRAM_BOT_TOKEN',
    // The Bot API URL is `.../bot<token>/method`, so a letter may precede it.
    pattern: /(?<![\d:-])\d{8,10}:([\w-]{35})(?![\w-])/g,
    secretGroup: 1,
  },
  {
    id: 'jwt',
    name: 'JWT',
    env: null,
    pattern: bounded('eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{20,}'),
    // Short JWTs are almost always jwt.io samples or test fixtures.
    ignore: match => match[0].length < 150,
  },
  {
    id: 'url-password',
    name: 'URL with an inline password',
    env: null,
    pattern: /\b[a-z][a-z0-9+.-]{1,20}:\/\/([^:/\s@'"`]{1,256}):([^@\s/'"`]{1,256})@(\[[^\]\s]*\]|[^\s/:?#'"`]+)/gi,
    prepare: withoutTemplates,
    secretGroup: 2,
    ignore: match => isPlaceholderUrlCredential(match[1] ?? '', match[2] ?? '', match[3] ?? ''),
    placeholders: false,
    fallback: true,
  },
  {
    id: 'authorization-header',
    name: 'Authorization header',
    env: null,
    pattern: /\bauthorization["']?\]?\s{0,10}[:=]\s{0,10}["']?(?:bearer|basic|token|bot)\s{1,10}([\w.~+/=-]{16,})/gi,
    secretGroup: 1,
    ignore: match => !isRandom(match[1] ?? ''),
    fallback: true,
  },
  {
    id: 'curl-user-password',
    name: 'password on a curl command line',
    env: null,
    pattern: /\bcurl\b[^\n|;&]{0,500}?\s(?:-[A-Za-z]*u|--user)[=\s]\s{0,10}["']?([^\s:'"]{1,256}):([^\s'"]{1,256})/g,
    prepare: withoutTemplates,
    secretGroup: 2,
    ignore: match => isDevCredential(match[1] ?? '', match[2] ?? '', '') || (match[2] ?? '').length < 4,
    placeholders: false,
    fallback: true,
  },
  {
    id: 'generic-secret',
    name: 'secret-looking value',
    env: null,
    // `NAME=value`, `name: "value"`, `name => value` and `--name value`. The
    // value is judged by isGenericNonSecret, so the name list can stay wide.
    pattern: new RegExp(`${SECRET_NAME}[\\w.-]{0,40}["']?\\]?(?:\\s{0,10}(?::=|[:=]|=>|<-)|(?<=--[\\w-]{1,80})(?=\\s))\\s{0,10}[\\t "'\`]?([\\w+./~^-][\\w+./=~^!@#%*-]{14,89})(?=[\\s"'\`,;)}]|</|$)`, 'gi'),
    secretGroup: 1,
    ignore: match => isNotASecretName(match) || isGenericNonSecret(match[1] ?? '', keyOf(match)),
    fallback: true,
  },
])
