import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

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
  console.error(`[semantic-sf-rag]      npx tsx src/ingest-pdfs.ts       # embed PDFs from ./pdfs/`);
  console.error(`[semantic-sf-rag]      npx tsx src/ingest.ts <url>      # scrape a Salesforce Help URL`);
  console.error(`[semantic-sf-rag]      npx tsx src/migrate-legacy.ts    # migrate from private-sf-doc-kb`);
  console.error(`[semantic-sf-rag]    Or set SF_DOCS_DB_PATH=/path/to/rag.sqlite`);
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
`);

console.error("[semantic-sf-rag] Database initialized at:", dbPath);
