const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

// Configure resolver to handle node-id3's Node.js dependencies
config.resolver.alias = {
  'node-id3': path.resolve(__dirname, 'polyfills/node-id3.js'),
  'fs': path.resolve(__dirname, 'polyfills/fs.js'),
  'path': path.resolve(__dirname, 'polyfills/path.js'),
  'stream': 'stream-browserify',
  'util': 'util',
  'buffer': 'buffer'
};

// Add Node.js core module polyfills
config.resolver.resolverMainFields = ['react-native', 'browser', 'main'];

// Configure resolver fallbacks for Node.js modules
config.resolver.fallback = {
  'node-id3': path.resolve(__dirname, 'polyfills/node-id3.js'),
  'fs': path.resolve(__dirname, 'polyfills/fs.js'),
  'path': path.resolve(__dirname, 'polyfills/path.js'),
  'stream': require.resolve('stream-browserify'),
  'util': require.resolve('util'),
  'buffer': require.resolve('buffer'),
  'crypto': false,
  'http': false,
  'https': false,
  'os': false,
  'url': false,
  'assert': false,
  'constants': false,
  'child_process': false
};

// Ensure these modules are treated as externals for bundling
config.resolver.platforms = ['ios', 'android', 'native', 'web'];

module.exports = config;