// Imports lib/index.js and nothing else, but its last path segment is
// `index`, which is also the basename of src/feature/index.js. The basename
// heuristic covers a module this test never loads.
const shared = require('../lib/index');
module.exports = shared;
