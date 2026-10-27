#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { runCli } from 'agent-base-kit'
import { shellSecrets } from './agent/hook'

void runCli(shellSecrets(fileURLToPath(new URL('../skills', import.meta.url))), import.meta.url)
