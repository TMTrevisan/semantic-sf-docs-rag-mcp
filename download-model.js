/**
 * download-model.js
 * Run this ONCE before starting the MCP server to pre-download
 * the all-MiniLM-L6-v2 embedding model from HuggingFace.
 * 
 * Usage:  node download-model.js
 */

import { pipeline } from '@xenova/transformers';

console.log('Downloading all-MiniLM-L6-v2 from HuggingFace...');
console.log('This is a one-time download of ~80MB.\n');

try {
    const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
        quantized: true,
    });

    // Run a quick smoke test to confirm model works
    const test = await extractor('test', { pooling: 'mean', normalize: true });
    console.log(`\n✅ Model downloaded and verified! (Vector size: ${test.data.length} dimensions)`);
    console.log('The model is cached locally. The MCP server will now start instantly.');
    process.exit(0);
} catch (e) {
    console.error('\n❌ Download failed:', e.message);
    console.error('\nIf you are behind a corporate firewall or VPN, try:');
    console.error('  1. Disconnect from VPN and retry');
    console.error('  2. Or manually download from: https://huggingface.co/Xenova/all-MiniLM-L6-v2');
    process.exit(1);
}
