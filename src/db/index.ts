import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Priority: SF_DOCS_DB_PATH env var → data/rag.sqlite bundled inside the npm package
const dbPath = process.env.SF_DOCS_DB_PATH
  ?? path.join(__dirname, '../../data/rag.sqlite');

const dbExists = fs.existsSync(dbPath);
if (!dbExists) {
  console.error(`[semantic-sf-rag] ⚠️  WARNING: No database found at: ${dbPath}`);
  console.error(`[semantic-sf-rag]    Searches will return empty results until you ingest data.`);
  console.error(`[semantic-sf-rag]    Run one of the following to populate the database:`);
  console.error(`[semantic-sf-rag]    Run: node scripts/ingest-pdfs.js  — or drop PDFs in ./pdfs/ first.`);
  console.error(`[semantic-sf-rag]    Override path: set SF_DOCS_DB_PATH env var.`);
}
export const db = new Database(dbPath);
db.loadExtension(sqliteVec.getLoadablePath());

db.exec(`
  CREATE TABLE IF NOT EXISTS chunks (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT,
    text_chunk TEXT
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
    embedding float[384]
  );

  CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);
`);

console.error("[semantic-sf-rag] Database initialized at:", dbPath);
