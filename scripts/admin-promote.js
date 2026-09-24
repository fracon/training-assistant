'use strict';

require('dotenv').config();
const { runPromotion } = require('./admin-commands');
const { runCommand } = require('./admin-runtime');

if (require.main === module) runCommand(runPromotion);
