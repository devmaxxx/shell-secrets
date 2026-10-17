import { execFileSync } from 'node:child_process'

// The stdin test runs the built cli, which must match the source under test.
export default function setup(): void {
  execFileSync('pnpm', ['exec', 'tsdown'], { stdio: 'pipe' })
}
