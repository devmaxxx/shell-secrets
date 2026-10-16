// Every fake is assembled at runtime from split prefixes and pseudo-random
// bodies, so this repo holds nothing secret-shaped for push protection to flag.
// The generator is seeded: a truly random body now and then spells "fake" or
// "xxxx" and is rightly read as a placeholder, which would make the suite flaky.
export const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const UPPER_NUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

let seed = 0x5EED
function next(): number {
  seed = (seed + 0x6D2B79F5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

export function rand(length: number, alphabet = ALNUM): string {
  return Array.from({ length }, () => alphabet[Math.floor(next() * alphabet.length)]).join('')
}

export const p = (...parts: string[]): string => parts.join('')

export const fake = {
  github: () => p('gh', 'p_', rand(36)),
  githubOauth: () => p('gh', 'o_', rand(36)),
  githubServer: () => p('gh', 's_', rand(36)),
  githubPat: () => p('github', '_pat_', rand(22), '_', rand(59)),
  atlassian: () => p('ATA', 'TT3', rand(180)),
  atlassianAccess: () => p('ATC', 'TT3', rand(180)),
  figma: () => p('fig', 'd_', rand(40)),
  slack: () => p('xo', 'xb-', rand(12, '0123456789'), '-', rand(24)),
  slackApp: () => p('xa', 'pp-1-', rand(11, UPPER_NUM), '-', rand(13, '0123456789'), '-', rand(64, '0123456789abcdef')),
  slackRefresh: () => p('xo', 'xe-1-', rand(40)),
  slackWebhook: () => p('https://hooks', '.slack.com/services/T', rand(10, UPPER_NUM), '/B', rand(10, UPPER_NUM), '/', rand(24)),
  anthropic: () => p('sk', '-ant-api03-', rand(90)),
  openai: () => p('sk', '-proj-', rand(48)),
  aws: () => p('AK', 'IA', rand(16, UPPER_NUM)),
  awsTemporary: () => p('AS', 'IA', rand(16, UPPER_NUM)),
  awsSecret: () => p('aws_secret', '_access_key = ', rand(40, `${ALNUM}/+`)),
  awsSessionToken: () => p('AWS_SESSION', '_TOKEN=', rand(300, `${ALNUM}/+`)),
  pem: () =>
    p('-----BEGIN ', 'RSA PRIVATE', ' KEY-----\n', rand(64), '\n', rand(64), '\n-----END RSA PRIVATE KEY-----'),
  mongo: () => p('mongodb', '+srv://app:', rand(20), '@cluster0.abcde.mongodb.net/db'),
  postgres: () => p('postgres', 'ql://svc:', rand(18), '@db.internal.example.org:5432/app'),
  redis: () => p('redis', '://default:', rand(24), '@cache.prod.internal:6379'),
  redisPasswordOnly: () => p('redis', '://:', rand(24), '@cache.prod.internal:6379'),
  mysql: () => p('mysql', '://app:', rand(18), '@db.internal.example.org:3306/app'),
  amqp: () => p('amqp', 's://svc:', rand(18), '@rabbit.prod.internal:5671'),
  postgresDriver: () => p('postgresql', '+asyncpg://prefect:', rand(18), '@postgres.prod.internal:5432/prefect'),
  postgresQuery: () => p('postgres', 'ql://db.prod.internal/app?user=app&password=', rand(18)),
  jdbc: () => p('jdbc:postgres', 'ql://db.prod.internal:5432/app?user=app&password=', rand(18)),
  telegram: () => p(rand(10, '123456789'), ':', 'AA', rand(33)),
  jwt: () => p('ey', 'J', rand(40), '.ey', 'J', rand(120), '.', rand(43)),
}

/** The rule each fake must be reported under. */
export const RULE_OF: Record<keyof typeof fake, string> = {
  github: 'github-token',
  githubOauth: 'github-token',
  githubServer: 'github-token',
  githubPat: 'github-fine-grained-token',
  atlassian: 'atlassian-api-token',
  atlassianAccess: 'atlassian-api-token',
  figma: 'figma-token',
  slack: 'slack-token',
  slackApp: 'slack-token',
  slackRefresh: 'slack-token',
  slackWebhook: 'slack-webhook-url',
  anthropic: 'anthropic-api-key',
  openai: 'openai-api-key',
  aws: 'aws-access-key',
  awsTemporary: 'aws-access-key',
  awsSecret: 'aws-secret-key',
  awsSessionToken: 'aws-secret-key',
  pem: 'private-key',
  mongo: 'database-uri-password',
  postgres: 'database-uri-password',
  redis: 'database-uri-password',
  redisPasswordOnly: 'database-uri-password',
  mysql: 'database-uri-password',
  amqp: 'database-uri-password',
  postgresDriver: 'database-uri-password',
  postgresQuery: 'database-uri-query-password',
  jdbc: 'database-uri-query-password',
  telegram: 'telegram-bot-token',
  jwt: 'jwt',
}
