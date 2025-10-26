#!/usr/bin/env node

/**
 * Generate Inline Snippet for Formo Analytics SDK
 * 
 * This script fetches the SDK and generates a complete inline snippet
 * that can be pasted directly into HTML without any external dependencies.
 * 
 * Usage:
 *   node scripts/generate-inline-snippet.js [version]
 *   node scripts/generate-inline-snippet.js 1.20.0
 *   node scripts/generate-inline-snippet.js latest
 */

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const version = process.argv[2] || 'latest';

function fetchSDK(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        // Follow redirect
        return fetchSDK(res.headers.location).then(resolve).catch(reject);
      }
      
      if (res.statusCode !== 200) {
        reject(new Error(`Failed to fetch SDK: HTTP ${res.statusCode}`));
        return;
      }

      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function generateInlineSnippet() {
  try {
    console.log(`📦 Fetching Formo Analytics SDK version: ${version}`);
    
    const url = `https://unpkg.com/@formo/analytics@${version}/dist/index.umd.min.js`;
    const sdkCode = await fetchSDK(url);
    
    // Get actual version if "latest" was requested
    let actualVersion = version;
    if (version === 'latest') {
      const packageJsonUrl = 'https://unpkg.com/@formo/analytics@latest/package.json';
      const packageJson = JSON.parse(await fetchSDK(packageJsonUrl));
      actualVersion = packageJson.version;
      console.log(`ℹ️  Latest version is: ${actualVersion}`);
    }
    
    // Calculate hash for integrity
    const hash = crypto.createHash('sha384').update(sdkCode).digest('base64');
    
    // Calculate size
    const sizeKB = Math.round(sdkCode.length / 1024);
    
    // Generate the inline snippet
    const snippet = `<!-- 
  Formo Analytics SDK v${actualVersion} - Inline Installation
  
  This is a self-contained, inline version of the Formo Analytics SDK.
  No external dependencies required - everything is included in this snippet.
  
  Generated: ${new Date().toISOString()}
  Version: ${actualVersion}
  Size: ${sizeKB} KB
  Integrity: sha384-${hash}
  
  Usage:
  1. Copy this entire snippet
  2. Paste into your HTML <head> section
  3. Replace YOUR_API_KEY with your actual Formo API key
  
  Documentation: https://docs.formo.so
  GitHub: https://github.com/getformo/sdk
-->
<script>
${sdkCode}
</script>
<script>
  // Initialize Formo Analytics
  if (typeof window.formofy === 'function') {
    window.formofy("YOUR_API_KEY", {
      debug: false, // Set to true for development/debugging
    });
    console.log('✅ Formo Analytics initialized');
  } else {
    console.error('❌ Formo Analytics failed to load');
  }
</script>`;

    // Save to file
    const outputDir = path.join(process.cwd(), 'dist');
    const outputFile = path.join(outputDir, `inline-snippet-${actualVersion}.html`);
    
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    fs.writeFileSync(outputFile, snippet, 'utf8');
    
    console.log('');
    console.log('✅ Inline snippet generated successfully!');
    console.log('');
    console.log('📊 Details:');
    console.log(`   Version: ${actualVersion}`);
    console.log(`   Size: ${sizeKB} KB`);
    console.log(`   Integrity: sha384-${hash}`);
    console.log('');
    console.log('📁 Saved to:', outputFile);
    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📋 Preview (first 500 characters):');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(snippet.substring(0, 500) + '...\n');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');
    console.log('🎯 Next Steps:');
    console.log('   1. Open the file:', outputFile);
    console.log('   2. Copy the entire contents');
    console.log('   3. Paste into your HTML <head>');
    console.log('   4. Replace YOUR_API_KEY with your actual API key');
    console.log('');
    console.log('💡 Tip: This snippet contains the entire SDK inline.');
    console.log('   No external files needed - perfect for maximum control!');
    console.log('');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

// Run the script
generateInlineSnippet();

