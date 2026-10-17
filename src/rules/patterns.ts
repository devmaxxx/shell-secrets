import { BOUNDARY_AFTER, BOUNDARY_BEFORE } from './constants'

export function bounded(body: string): RegExp {
  return new RegExp(`${BOUNDARY_BEFORE}${body}${BOUNDARY_AFTER}`, 'g')
}

// `${PW:-default}` and `${process.env.PW}` hold colons and dots of their own,
// which would split a URI's user from its password in the wrong place. The cap
// keeps a run of unclosed `${` linear instead of quadratic.
export function withoutTemplates(text: string): string {
  return text.replace(/\$\{[^}\s]{0,100}\}/g, template => `$${'V'.repeat(template.length - 1)}`)
}
