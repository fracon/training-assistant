'use strict';

require('dotenv').config();
const { runBootstrap } = require('./admin-commands');
const { runCommand } = require('./admin-runtime');

if (require.main === module) runCommand(runBootstrap);
