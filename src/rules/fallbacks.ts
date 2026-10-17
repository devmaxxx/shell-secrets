import type { Rule } from '../types'
import { SECRET_NAME } from './constants'
import { isDevCredential, isPlaceholderUrlCredential } from './credentials'
import { isGenericNonSecret, isNotASecretName, keyOf } from './generic'
import { withoutTemplates } from './patterns'
import { isRandom } from './randomness'

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
]
