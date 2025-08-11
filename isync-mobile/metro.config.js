const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

// Blacklist node-id3 module completely to prevent Metro from trying to bundle it
config.resolver.blacklistRE = /node_modules\/node-id3\/.*/;

// Configure resolver to handle Node.js dependencies with polyfills
config.resolver.alias = {
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