// Covers src/b.js as a colocated sibling, without importing it by path.
const b = require('./b');
module.exports = b;
