/**
 * Build script for iSync Lambda functions
 * 
 * This script:
 * 1. Compiles TypeScript to JavaScript
 * 2. Bundles each Lambda function with its dependencies
 * 3. Creates optimized ZIP files for deployment
 * 4. Generates source maps for debugging
 */

import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';
import archiver from 'archiver';
import { performance } from 'perf_hooks';

interface BuildConfig {
  name: string;
  entry: string;
  outfile: string;
  external?: string[];
}

// Lambda function configurations
const LAMBDA_FUNCTIONS: BuildConfig[] = [
  {
    name: 'upload-handler',
    entry: 'src/functions/upload-handler/index.ts',
    outfile: 'dist/upload-handler/index.js',
  },
  {
    name: 'metadata-processor',
    entry: 'src/functions/metadata-processor/index.ts',
    outfile: 'dist/metadata-processor/index.js',
  },
  {
    name: 'queue-manager',
    entry: 'src/functions/queue-manager/index.ts',
    outfile: 'dist/queue-manager/index.js',
  },
  {
    name: 'ec2-controller',
    entry: 'src/functions/ec2-controller/index.ts',
    outfile: 'dist/ec2-controller/index.js',
  },
];

// Build options
const BUILD_OPTIONS: esbuild.BuildOptions = {
  bundle: true,
  minify: true,
  sourcemap: true,
  target: 'node18',
  format: 'cjs',
  platform: 'node',
  metafile: true,
  treeShaking: true,
  
  // External dependencies that should be included in node_modules
  external: [
    // AWS SDK is available in Lambda runtime
    // '@aws-sdk/*', // Keep for now as we're using specific versions
  ],
  
  // Path resolution
  resolveExtensions: ['.ts', '.js'],
  
  // Define environment variables for build-time optimization
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  
  // Minimize bundle size
  dropLabels: ['DEV'],
  
  // Keep function names for better debugging
  keepNames: true,
};

/**
 * Clean dist directory
 */
async function cleanDist(): Promise<void> {
  const distDir = path.resolve('dist');
  
  if (fs.existsSync(distDir)) {
    console.log('🧹 Cleaning dist directory...');
    fs.rmSync(distDir, { recursive: true, force: true });
  }
  
  fs.mkdirSync(distDir, { recursive: true });
}

/**
 * Build a single Lambda function
 */
async function buildFunction(config: BuildConfig): Promise<void> {
  const startTime = performance.now();
  
  console.log(`📦 Building ${config.name}...`);
  
  // Ensure output directory exists
  const outDir = path.dirname(config.outfile);
  fs.mkdirSync(outDir, { recursive: true });
  
  try {
    const result = await esbuild.build({
      ...BUILD_OPTIONS,
      entryPoints: [config.entry],
      outfile: config.outfile,
      external: config.external,
    });
    
    // Log build results
    if (result.metafile) {
      const analysis = await esbuild.analyzeMetafile(result.metafile);
      const buildTime = Math.round(performance.now() - startTime);
      
      console.log(`  ✅ ${config.name} built in ${buildTime}ms`);
      console.log(`     Output: ${getFileSize(config.outfile)}`);
      
      // Save metafile for analysis
      const metaPath = path.join(outDir, 'meta.json');
      fs.writeFileSync(metaPath, JSON.stringify(result.metafile, null, 2));
    }
    
  } catch (error) {
    console.error(`❌ Failed to build ${config.name}:`, error);
    throw error;
  }
}

/**
 * Create ZIP file for Lambda deployment
 */
async function createZip(functionName: string): Promise<void> {
  const startTime = performance.now();
  
  console.log(`📁 Creating ZIP for ${functionName}...`);
  
  const sourceDir = path.resolve('dist', functionName);
  const zipPath = path.resolve('dist', `${functionName}.zip`);
  
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    
    output.on('close', () => {
      const buildTime = Math.round(performance.now() - startTime);
      const zipSize = getFileSize(zipPath);
      
      console.log(`  ✅ ${functionName}.zip created in ${buildTime}ms (${zipSize})`);
      resolve();
    });
    
    output.on('error', reject);
    archive.on('error', reject);
    
    archive.pipe(output);
    
    // Add the built JavaScript file
    const jsFile = path.join(sourceDir, 'index.js');
    const mapFile = path.join(sourceDir, 'index.js.map');
    
    if (fs.existsSync(jsFile)) {
      archive.file(jsFile, { name: 'index.js' });
    }
    
    if (fs.existsSync(mapFile)) {
      archive.file(mapFile, { name: 'index.js.map' });
    }
    
    // Add package.json for Lambda
    const packageJson = {
      name: functionName,
      version: '1.0.0',
      description: `iSync ${functionName} Lambda function`,
      main: 'index.js',
      engines: {
        node: '>=18.0.0'
      }
    };
    
    archive.append(JSON.stringify(packageJson, null, 2), { name: 'package.json' });
    
    archive.finalize();
  });
}

/**
 * Get formatted file size
 */
function getFileSize(filePath: string): string {
  const stats = fs.statSync(filePath);
  const bytes = stats.size;
  
  if (bytes === 0) return '0 B';
  
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

/**
 * Validate built files
 */
function validateBuild(): void {
  console.log('🔍 Validating build outputs...');
  
  let hasErrors = false;
  
  for (const config of LAMBDA_FUNCTIONS) {
    const jsFile = config.outfile;
    const zipFile = path.resolve('dist', `${config.name}.zip`);
    
    // Check JavaScript file
    if (!fs.existsSync(jsFile)) {
      console.error(`❌ Missing JavaScript file: ${jsFile}`);
      hasErrors = true;
    } else {
      const size = fs.statSync(jsFile).size;
      if (size === 0) {
        console.error(`❌ Empty JavaScript file: ${jsFile}`);
        hasErrors = true;
      }
    }
    
    // Check ZIP file
    if (!fs.existsSync(zipFile)) {
      console.error(`❌ Missing ZIP file: ${zipFile}`);
      hasErrors = true;
    } else {
      const size = fs.statSync(zipFile).size;
      if (size === 0) {
        console.error(`❌ Empty ZIP file: ${zipFile}`);
        hasErrors = true;
      }
      
      // Check ZIP size limits (Lambda has a 50MB limit for ZIP files)
      const maxSize = 50 * 1024 * 1024; // 50MB
      if (size > maxSize) {
        console.warn(`⚠️ ZIP file ${zipFile} is ${getFileSize(zipFile)}, close to Lambda limit`);
      }
    }
  }
  
  if (hasErrors) {
    console.error('❌ Build validation failed');
    process.exit(1);
  }
  
  console.log('✅ Build validation passed');
}

/**
 * Generate build summary
 */
function generateSummary(): void {
  console.log('\n📊 Build Summary:');
  console.log('='.repeat(50));
  
  let totalSize = 0;
  
  for (const config of LAMBDA_FUNCTIONS) {
    const zipFile = path.resolve('dist', `${config.name}.zip`);
    const jsFile = config.outfile;
    
    if (fs.existsSync(zipFile) && fs.existsSync(jsFile)) {
      const zipSize = fs.statSync(zipFile).size;
      const jsSize = fs.statSync(jsFile).size;
      
      totalSize += zipSize;
      
      console.log(`${config.name.padEnd(20)} JS: ${getFileSize(jsFile).padStart(8)} | ZIP: ${getFileSize(zipFile).padStart(8)}`);
    }
  }
  
  console.log('='.repeat(50));
  console.log(`Total ZIP size: ${formatBytes(totalSize)}`);
  console.log('\n🎉 Build completed successfully!');
  console.log('\nNext steps:');
  console.log('1. Run tests: npm test');
  console.log('2. Deploy functions: npm run deploy:all');
}

function formatBytes(bytes: number): string {
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

/**
 * Main build function
 */
async function main(): Promise<void> {
  const startTime = performance.now();
  
  try {
    console.log('🚀 Starting iSync Lambda build process...\n');
    
    // Clean previous builds
    await cleanDist();
    
    // Build all functions in parallel for speed
    console.log('Building functions...');
    await Promise.all(LAMBDA_FUNCTIONS.map(config => buildFunction(config)));
    
    // Create ZIP files
    console.log('\nCreating deployment packages...');
    await Promise.all(LAMBDA_FUNCTIONS.map(config => createZip(config.name)));
    
    // Validate build
    validateBuild();
    
    // Generate summary
    const totalTime = Math.round(performance.now() - startTime);
    console.log(`\n⏱️ Total build time: ${totalTime}ms`);
    generateSummary();
    
  } catch (error) {
    console.error('❌ Build failed:', error);
    process.exit(1);
  }
}

// Run the build if this file is executed directly
if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal build error:', error);
    process.exit(1);
  });
}

export { main as build };