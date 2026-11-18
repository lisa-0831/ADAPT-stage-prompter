#!/usr/bin/env node
'use strict';

// Same installed Versioned Library as `npm start`. The path comes from
// scripts/install-paths.js. This file does not read a hardcoded home directory.
require('./start-installed').run();
