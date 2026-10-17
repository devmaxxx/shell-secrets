#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { main } from './agents'

process.exitCode = main(process.argv.slice(2), {
  stdin: () => readFileSync(0, 'utf8'),
  script: fileURLToPath(import.meta.url),
})
