// Basic path polyfill
module.exports = {
  join: (...parts) => parts.filter(Boolean).join('/'),
  basename: (path) => path.split('/').pop() || '',
  dirname: (path) => path.split('/').slice(0, -1).join('/') || '/',
  extname: (path) => {
    const base = path.split('/').pop() || '';
    const dotIndex = base.lastIndexOf('.');
    return dotIndex > 0 ? base.slice(dotIndex) : '';
  }
};