import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Priority: SF_DOCS_DB_PATH env var → local rag.sqlite in cwd → fallback next to dist/
const dbPath = process.env.SF_DOCS_DB_PATH
  ?? path.join(process.cwd(), 'rag.sqlite');
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

console.log("Database initialized with sqlite-vec extensions at:", dbPath);
