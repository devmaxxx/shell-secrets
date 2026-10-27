#!/usr/bin/env node
import { Buffer } from 'node:buffer'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { main } from './agent/main'

// A synchronous read of fd 0 fails with EAGAIN on a non-blocking pipe once the
// payload outgrows its buffer, and any exit but 2 lets the call run. Read to
// the end instead; a read that fails leaves the input empty, which blocks.
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  try {
    for await (const chunk of process.stdin)
      chunks.push(Buffer.from(chunk))
  }
  catch {
    return ''
  }
  return Buffer.concat(chunks).toString('utf8')
}

const argv = process.argv.slice(2)
const input = argv[0] === 'hook' ? await readStdin() : ''
process.exitCode = main(argv, { stdin: () => input, script: fileURLToPath(import.meta.url), skills: fileURLToPath(new URL('../skills', import.meta.url)) })
