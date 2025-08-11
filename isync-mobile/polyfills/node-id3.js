// Polyfill for node-id3 that returns null functions
// This prevents Metro from trying to bundle the actual node-id3 module
module.exports = {
  update: () => null,
  write: () => null,
  read: () => null,
  remove: () => null,
  create: () => null
};