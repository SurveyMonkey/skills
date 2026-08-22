// Imports the parent by name and nothing else. It says nothing about whether
// the transitive package underneath express is exercised, and must not cover
// the affected modules on its own.
const express = require('express');
module.exports = express();
