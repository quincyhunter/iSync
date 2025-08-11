const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

// Configure resolver to handle node-id3's Node.js dependencies
config.resolver.alias = {
  'fs': path.resolve(__dirname, 'polyfills/fs.js'),
  'path': path.resolve(__dirname, 'polyfills/path.js'),
  'stream': 'stream-browserify',
  'util': 'util',
  'buffer': 'buffer'
};

// Ensure these modules are treated as externals for bundling
config.resolver.platforms = ['ios', 'android', 'native', 'web'];

module.exports = config;