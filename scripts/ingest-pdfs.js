/**
 * scripts/ingest-pdfs.js
 * 
 * Add your own Salesforce PDFs to the semantic vector database.
 * Drop PDF files into the `pdfs/` folder next to this script, then run:
 * 
 *   npm run ingest-pdfs
 *   node scripts/ingest-pdfs.js
 */

import { pipeline } from '@xenova/transformers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

const require = createRequire(import.meta.url);
const pdf = require('pdf-parse');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PDF_DIR = path.join(__dirname, '../pdfs');
const DB_PATH = process.env.SF_DOCS_DB_PATH ?? path.join(__dirname, '../data/rag.sqlite');
const MODEL_PATH = path.join(__dirname, '../models/Xenova/all-MiniLM-L6-v2');
const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

console.log(`\n📚 Salesforce PDF Ingestion Script`);
console.log(`Database: ${DB_PATH}`);
console.log(`PDFs folder: ${PDF_DIR}\n`);

if (!fs.existsSync(PDF_DIR)) {
    fs.mkdirSync(PDF_DIR, { recursive: true });
}

const files = fs.readdirSync(PDF_DIR).filter(f => f.toLowerCase().endsWith('.pdf'));

if (files.length === 0) {
    console.log('No PDF files found in the pdfs/ folder.');
    console.log('Drop your Salesforce PDF documents into:', PDF_DIR);
    process.exit(0);
}

console.log(`Found ${files.length} PDFs to process...\n`);

// Open the database
const db = new Database(DB_PATH);
db.loadExtension(sqliteVec.getLoadablePath());

// Ensure tables exist
db.exec(`
  CREATE TABLE IF NOT EXISTS chunks (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT,
    text_chunk TEXT
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
    embedding float[384]
  );
`);

// Load model
const modelSource = fs.existsSync(MODEL_PATH) ? MODEL_PATH : MODEL_ID;
console.log(`Loading embedding model from: ${modelSource}`);
const extractor = await pipeline('feature-extraction', modelSource, { quantized: true });

const insertChunk = db.prepare(`INSERT INTO chunks (source, text_chunk) VALUES (?, ?)`);
const insertVec = db.prepare(`INSERT INTO vec_chunks(rowid, embedding) VALUES (last_insert_rowid(), ?)`);

let success = 0;
for (const file of files) {
    const filePath = path.join(PDF_DIR, file);
    console.log(`Processing: ${file}`);
    try {
        const buffer = fs.readFileSync(filePath);
        const data = await pdf(buffer);
        const title = file.replace(/\.pdf$/i, '').replace(/_/g, ' ');
        const localUri = `file://offline/${file.replace(/\s+/g, '_')}`;

        const CHUNK_SIZE = 800;
        const OVERLAP = 100;
        const text = data.text || '';
        const chunks = [];
        for (let i = 0; i < text.length; i += CHUNK_SIZE - OVERLAP) {
            chunks.push(`Source: ${title}\nURL: ${localUri}\n\n${text.slice(i, i + CHUNK_SIZE)}`);
        }

        console.log(`  → ${chunks.length} chunks`);
        for (const chunk of chunks) {
            const out = await extractor(chunk, { pooling: 'mean', normalize: true });
            const embedding = new Float32Array(Array.from(out.data));
            insertChunk.run(localUri, chunk);
            insertVec.run(embedding);
        }
        console.log(`  ✅ Done`);
        success++;
    } catch (e) {
        console.error(`  ❌ Failed: ${e.message}`);
    }
}

const total = db.prepare('SELECT COUNT(*) as n FROM chunks').get();
console.log(`\n🏁 Finished: ${success}/${files.length} PDFs indexed`);
console.log(`Total chunks in database: ${total.n.toLocaleString()}`);
