// Imports the directory, which is how a module resolver reaches
// src/feature/index.js. The last path segment is `feature`, the module's
// basename is `index`, and they do not match: uncovered. Documented limit.
const feature = require('../src/feature');
module.exports = feature;
