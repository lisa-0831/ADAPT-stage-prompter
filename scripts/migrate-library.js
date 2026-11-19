#!/usr/bin/env node
const { runCli } = require('../library-migration-cli');

process.exitCode = runCli(process.argv.slice(2));
