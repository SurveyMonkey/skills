// Covers src/a.js by importing it: the specifier's last segment is `a`.
const { pick } = require('../src/a');
module.exports = { pick };
