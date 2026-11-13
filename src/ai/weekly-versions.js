'use strict';

// Weekly workout adapter versions, shared by the adapter and the structure
// converter without a circular import. v3 executions stay readable and
// applicable; new generations use v4.
const VERSION = 'weekly-workouts-v4';
const LEGACY_VERSION = 'weekly-workouts-v3';
const SUPPORTED_VERSIONS = [LEGACY_VERSION, VERSION];

module.exports = { VERSION, LEGACY_VERSION, SUPPORTED_VERSIONS };
