import { VARIABLE } from '../scan/constants'
import { hasMarker } from '../scan/placeholder'
import { DEV_HOSTS, DEV_PASSWORDS, RESERVED_HOST } from './constants'

/**
 * Compose files and local READMEs are full of `postgres:postgres@localhost`;
 * flagging those would train everyone to ignore the scanner.
 */
export function isDevCredential(user: string, password: string, host: string): boolean {
  return (
    VARIABLE.test(password)
    || hasMarker(password)
    || password === user
    || DEV_PASSWORDS.test(password)
    || DEV_HOSTS.test(host)
  )
}

// A URL's password is checked like a database URI's, and must be long enough
// not to be a hand-typed stand-in.
export function isPlaceholderUrlCredential(user: string, password: string, host: string): boolean {
  return (
    isDevCredential(user, password, host)
    || password.length < 4
    || /^(.)\1*$/.test(password)
    || RESERVED_HOST.test(host)
  )
}
