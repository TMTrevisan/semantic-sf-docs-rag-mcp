import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, '../../rag.sqlite');
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
