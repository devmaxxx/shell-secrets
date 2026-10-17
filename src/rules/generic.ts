import { decodeBase64 } from '../scan/base64'
import { FILE_NAME, FILE_PATH, ID_NAME, IDENTIFIER_WORD, MEMBER_PATH, NOT_A_SECRET_NAME, SEQUENCES, UUID } from './constants'
import { isRandom } from './randomness'
// `q8Zr3LmVbN.Tw7xKd2pYs` has the shape of a path too; a part with digits past
// a short `v2` or `s3` reads as random, not as a property name.
const isMemberPath = (value: string): boolean => MEMBER_PATH.test(value) && value.split('.').every(part => part.length <= 4 || !/\d/.test(part))
function isIdentifier(value: string): boolean {
  const words = value.match(IDENTIFIER_WORD) ?? []
  return words.join('') === value
    && words.every(word => /^(?:[A-Z]?[a-z]{3,}|[A-Z]{2,}|\d{1,3})$/.test(word))
    && words.filter(word => /^[A-Z][a-z]/.test(word)).length >= 2
}

const snakeCase = (name: string): string => name.replace(/["'\]\s:=<>-]+$/, '').replace(/([a-z\d])([A-Z])/g, '$1_$2').toLowerCase()

/** The matched name up to its value, from the secret word on: `token.go`, not `config.token`. */
export const keyOf = (match: RegExpExecArray): string => snakeCase(match[0].slice(0, match[0].length - (match[1]?.length ?? 0)))

/** The variable's whole name: the word joined to the match, then the match up to its value. */
function nameOf(match: RegExpExecArray): string {
  const before = match.input.slice(Math.max(0, match.index - 40), match.index).match(/[\w.-]*$/)?.[0] ?? ''
  return snakeCase(before) + keyOf(match)
}

export function isNotASecretName(match: RegExpExecArray): boolean {
  return FILE_NAME.test(keyOf(match)) || NOT_A_SECRET_NAME.test(nameOf(match).replace(/[.-]/g, '_'))
}

/**
 * A value under a secret-sounding name is reported only when it reads as
 * machine-generated. Names, paths (`process.env.TOKEN`, `./key.pem`) and runs
 * of the alphabet are not, whatever they are called. The cheap shape checks
 * run before the randomness test.
 */
// Base64 of hex or a UUID draws on a handful of characters, so it reads as
// patterned; the text it encodes is what shows whether it is random.
export function isGenericNonSecret(value: string, name: string): boolean {
  const decoded = value.length % 4 === 0 && /^[A-Z0-9+/]+={0,2}$/i.test(value) ? decodeBase64(value) : null
  return isPlainNonSecret(value, name) && (decoded === null || isPlainNonSecret(decoded, name))
}

function isPlainNonSecret(value: string, name: string): boolean {
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
