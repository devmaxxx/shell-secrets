import type { Rule } from '../types'
import { SECRET_NAME } from './constants'
import { isDevCredential, isPlaceholderUrlCredential } from './credentials'
import { isGenericNonSecret, isNotASecretName, keyOf } from './generic'
import { withoutTemplates } from './patterns'
import { isRandom } from './randomness'

// What the shell, a batch file or a template fills in before the client sees
// it: `$(cat pw)`, `$$PW`, `%PW%`, `@PW@`, `{pw}`.
const FILLED_IN = /^(?:\$[($]|`|(?:%\w+%|@\w+@|\{[\w.-]+\})$)/

function isNotAMysqlPassword(value: string): boolean {
  return isDevCredential('', value, '') || value.length < 4 || /^[\d.:]+(?:\/\w+)?$/.test(value) || FILLED_IN.test(value)
}

/**
 * Rules for secrets no prefix names. Each marks itself `fallback`, so it gives
 * way to a provider rule that matches the same span.
 */
export const fallbackRules: readonly Rule[] = [
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
    id: 'mysql-password',
    name: 'password on a mysql command line',
    env: null,
    // The MySQL clients take the password glued to `-p`; a bare `-p` prompts
    // for it. A docker `-p3306:3306` beside a container named mysql is a port.
    // The client may stand in a path, in quotes or after a continuation line.
    pattern: /(?:^|[\s;&|(`"'/])(?:mysql|mysqldump|mysqladmin|mysqlimport|mysqlcheck|mysqlshow|mysqlpump|mariadb(?:-dump|-admin)?)(?=\s)(?:\\\n|[^\n|;&]){1,500}?(?<=\s)-p["']?([^\s'"]{1,256})/g,
    prepare: withoutTemplates,
    secretGroup: 1,
    ignore: match => isNotAMysqlPassword(match[1] ?? ''),
    placeholders: false,
    fallback: true,
  },
  {
    id: 'generic-secret',
    name: 'secret-looking value',
    env: null,
    // `NAME=value`, `name: "value"`, `name => value`, `--name value` and
    // `<name>value</name>`. The value is judged by isGenericNonSecret, so the
    // name list can stay wide; the value takes the punctuation password
    // generators emit.
    pattern: new RegExp(`${SECRET_NAME}[\\w.-]{0,40}["']?\\]?(?:\\s{0,10}(?::=|[:=]|=>|<-)|>(?=[^\\s<]{1,90}</)|(?<=--[\\w-]{1,80})(?=\\s))\\s{0,10}[\\t "'\`]?([\\w+./~^-][\\w+./=~^!@#%*&?$|:-]{14,89})(?=[\\s"'\`,;)}]|</|$)`, 'gi'),
    secretGroup: 1,
    ignore: match => isNotASecretName(match) || isGenericNonSecret(match[1] ?? '', keyOf(match)),
    fallback: true,
  },
]
