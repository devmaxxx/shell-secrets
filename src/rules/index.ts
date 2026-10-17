import type { Rule } from '../types'
import { fallbackRules } from './fallbacks'
import { providerRules } from './providers'

/** The built-in rules, in the order they run. */
export const defaultRules: readonly Rule[] = Object.freeze([...providerRules, ...fallbackRules])
