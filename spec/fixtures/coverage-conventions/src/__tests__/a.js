// Covers src/a.js by convention alone: a __tests__/<basename>.* entry beside
// the module. It deliberately imports nothing, so the sibling route is the
// only one that can cover src/a.js here.
export const cases = ['pick', 'omit'];
