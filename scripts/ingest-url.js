/**
 * scripts/ingest-url.js
 *
 * Fetches a Salesforce Help or developer docs URL and ingests its text content
 * into the local vector database using fetch + simple HTML-to-text extraction.
 *
 * Usage:
 *   node scripts/ingest-url.js https://help.salesforce.com/s/articleView?id=sf.some_article.htm
 *   npm run ingest-url -- https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/
 */

import { pipeline, env } from '@xenova/transformers';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = process.env.SF_DOCS_DB_PATH ?? path.join(__dirname, '../data/rag.sqlite');
const MODELS_DIR = path.join(__dirname, '../models');
const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const CHUNK_SIZE = 800;
const OVERLAP = 100;

const url = process.argv[2];
if (!url) {
    console.error('Usage: node scripts/ingest-url.js <url>');
    console.error('Example: node scripts/ingest-url.js https://help.salesforce.com/s/articleView?id=sf.apex_intro.htm');
    process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fetchUrl(targetUrl, depth = 0) {
    if (depth > 5) return Promise.reject(new Error('Too many redirects'));
    return new Promise((resolve, reject) => {
        const proto = targetUrl.startsWith('https') ? https : http;
        proto.get(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 SF-Docs-RAG-Ingest/2.1',
                'Accept': 'text/html,application/xhtml+xml'
            }
        }, (res) => {
            if ([301, 302, 307, 308].includes(res.statusCode)) {
                // Resolve relative Location headers against the current URL
                const location = res.headers.location || '';
                const next = location.startsWith('http')
                    ? location
                    : new URL(location, targetUrl).href;
                res.resume(); // drain socket
                return fetchUrl(next, depth + 1).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`HTTP ${res.statusCode} for ${targetUrl}`));
            }
            let body = '';
            res.setEncoding('utf8');
            res.on('data', d => body += d);
            res.on('end', () => resolve(body));
        }).on('error', reject);
    });
}

function htmlToText(html) {
    return html
        // Remove scripts, styles, nav, header, footer
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[\s\S]*?<\/nav>/gi, '')
        .replace(/<header[\s\S]*?<\/header>/gi, '')
        .replace(/<footer[\s\S]*?<\/footer>/gi, '')
        // Convert common block elements to newlines
        .replace(/<\/(p|div|li|h[1-6]|tr|br|section|article)>/gi, '\n')
        // Strip remaining tags
        .replace(/<[^>]+>/g, ' ')
        // Decode common HTML entities
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
        // Collapse whitespace
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log(`\n🌐 URL Ingest — ${url}`);
console.log(`Database: ${DB_PATH}\n`);

// Open DB
const db = new Database(DB_PATH);
db.loadExtension(sqliteVec.getLoadablePath());
db.exec(`
  CREATE TABLE IF NOT EXISTS chunks (rowid INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT, text_chunk TEXT);
  CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(embedding float[384]);
  CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);
`);

// Dedup check
const existing = db.prepare('SELECT COUNT(*) as n FROM chunks WHERE source = ?').get(url);
if (existing.n > 0) {
    console.log(`⚠️  Already indexed (${existing.n} chunks) — source: ${url}`);
    console.log(`Use delete_source MCP tool to remove it first if you want to re-index.`);
    process.exit(0);
}

// Fetch
process.stdout.write('⬇  Fetching...');
const html = await fetchUrl(url);
const text = htmlToText(html);
if (text.length < 200) {
    console.error('\n❌ Very little text extracted — page may require JavaScript. Try a PDF instead.');
    process.exit(1);
}
console.log(` ${text.length.toLocaleString()} chars extracted`);

// Chunk
const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
const pageTitle = titleMatch ? titleMatch[1].trim().replace(/\s*[\|–-].*$/, '') : url;
const chunks = [];
for (let pos = 0; pos < text.length; pos += CHUNK_SIZE - OVERLAP) {
    chunks.push(`Source: ${pageTitle}\nURL: ${url}\n\n${text.slice(pos, pos + CHUNK_SIZE)}`);
}
console.log(`📊 ${chunks.length} chunks to embed\n`);

// Load model
if (fs.existsSync(path.join(MODELS_DIR, MODEL_ID))) {
    env.localModelPath = MODELS_DIR;
    env.allowRemoteModels = false;
    console.log(`Loading bundled model...\n`);
} else {
    console.log(`Downloading model from HuggingFace...\n`);
}
const extractor = await pipeline('feature-extraction', MODEL_ID, { quantized: true });


process.stdout.write('🔲 Embedding');
const embeddings = [];
for (let i = 0; i < chunks.length; i++) {
    const out = await extractor(chunks[i], { pooling: 'mean', normalize: true });
    embeddings.push(new Float32Array(Array.from(out.data)));
    if (i % 10 === 0) process.stdout.write('.');
}
console.log(` done`);

// Insert with transaction
const insertChunk = db.prepare('INSERT INTO chunks (source, text_chunk) VALUES (?, ?)');
const insertVec = db.prepare('INSERT INTO vec_chunks(rowid, embedding) VALUES (last_insert_rowid(), ?)');
const writeTx = db.transaction(() => {
    for (let i = 0; i < chunks.length; i++) {
        insertChunk.run(url, chunks[i]);
        insertVec.run(embeddings[i]);
    }
});
writeTx();

const total = db.prepare('SELECT COUNT(DISTINCT source) as n FROM chunks').get();
console.log(`\n✅ Indexed: ${pageTitle}`);
console.log(`   Source:  ${url}`);
console.log(`   Chunks:  ${chunks.length}`);
console.log(`   Total sources in DB: ${total.n}`);
