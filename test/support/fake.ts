// Every fake is assembled at runtime from split prefixes and pseudo-random
// bodies, so this repo holds nothing secret-shaped for push protection to flag.
// The generator is seeded: a truly random body now and then spells "fake" or
// "xxxx" and is rightly read as a placeholder, which would make the suite flaky.
import { withGitHubChecksum } from '../../src/rules/checksum'

export const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const UPPER_NUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const HEX = '0123456789abcdef'
const BECH32_UPPER = 'QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L'

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
  github: () => withGitHubChecksum(p('gh', 'p_'), rand(30)),
  githubOauth: () => withGitHubChecksum(p('gh', 'o_'), rand(30)),
  githubServer: () => withGitHubChecksum(p('gh', 's_'), rand(30)),
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
  google: () => p('AI', 'za', rand(35)),
  googleOauth: () => p('GOC', 'SPX-', rand(28)),
  groq: () => p('gs', 'k_', rand(52)),
  xai: () => p('xa', 'i-', rand(80)),
  huggingface: () => p('h', 'f_', rand(34)),
  gitlab: () => p('glp', 'at-', rand(20)),
  gitlabRoutable: () => p('glp', 'at-', rand(27), '.01.', rand(9)),
  npm: () => p('np', 'm_', rand(36)),
  pypi: () => p('py', 'pi-AgEIcHlwaS5vcmc', rand(150)),
  stripe: () => p('sk', '_live_', rand(99)),
  stripeRestricted: () => p('rk', '_live_', rand(99)),
  stripeWebhook: () => p('wh', 'sec_', rand(32)),
  sendgrid: () => p('S', 'G.', rand(22), '.', rand(43)),
  linear: () => p('lin', '_api_', rand(40)),
  shopify: () => p('shp', 'at_', rand(32, HEX)),
  digitalocean: () => p('do', 'p_v1_', rand(64, HEX)),
  discordWebhook: () => p('https://discord', '.com/api/webhooks/', rand(19, '0123456789'), '/', rand(68)),
  age: () => p('AGE-SECRET', '-KEY-1', rand(58, BECH32_UPPER)),
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
  sentry: () => p('sntr', 'ys_', 'eyJ', rand(120)),
  sentryUser: () => p('sntr', 'yu_', rand(64, HEX)),
  databricks: () => p('da', 'pi', rand(32, HEX)),
  onepassword: () => p('op', 's_', btoa(JSON.stringify({ signInAddress: 'my.1password.com', email: `${rand(26).toLowerCase()}@1passwordserviceaccounts.com`, secretKey: rand(34), srpX: rand(64, HEX) }))),
  urlPassword: () => p('https://deploy:', rand(20), '@registry.internal.io/v2'),
  authorizationHeader: () => p('-H "Author', 'ization: Bearer ', rand(40), '"'),
  curlUser: () => p('curl -u deploy:', rand(20), ' https://api.internal.io'),
  genericAssignment: () => p('API_', 'TOKEN=', rand(32)),
  genericOption: () => p('deploy --api', '-key ', rand(32)),
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
  google: 'google-api-key',
  googleOauth: 'google-oauth-client-secret',
  groq: 'groq-api-key',
  xai: 'xai-api-key',
  huggingface: 'huggingface-token',
  gitlab: 'gitlab-token',
  gitlabRoutable: 'gitlab-token',
  npm: 'npm-token',
  pypi: 'pypi-token',
  stripe: 'stripe-secret-key',
  stripeRestricted: 'stripe-secret-key',
  stripeWebhook: 'stripe-webhook-secret',
  sendgrid: 'sendgrid-api-key',
  linear: 'linear-api-key',
  shopify: 'shopify-token',
  digitalocean: 'digitalocean-token',
  discordWebhook: 'discord-webhook-url',
  age: 'age-secret-key',
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
  sentry: 'sentry-token',
  sentryUser: 'sentry-token',
  databricks: 'databricks-token',
  onepassword: 'onepassword-service-account-token',
  urlPassword: 'url-password',
  authorizationHeader: 'authorization-header',
  curlUser: 'curl-user-password',
  genericAssignment: 'generic-secret',
  genericOption: 'generic-secret',
}
