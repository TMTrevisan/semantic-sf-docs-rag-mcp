import { pipeline } from '@xenova/transformers';
import { db } from './db/index.js';

async function main() {
  console.log('Loading local model (all-MiniLM-L6-v2)...');
  const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
    quantized: true,
  });

  const textChunk = "Salesforce provides an innovative CRM platform.";
  console.log(`Embedding text: "${textChunk}"`);

  const output = await extractor(textChunk, { pooling: 'mean', normalize: true });
  const embedding = Array.from(output.data);

  if (embedding.length !== 384) {
    console.error(`Expected 384 dimensions, got ${embedding.length}`);
    return;
  }

  console.log('Inserting into database...');

  const insertChunk = db.prepare(`INSERT INTO chunks (source, text_chunk) VALUES (?, ?)`);
  const info = insertChunk.run('test_source', textChunk);
  const rowid = Number(info.lastInsertRowid);

  const insertVec = db.prepare(`INSERT INTO vec_chunks(rowid, embedding) VALUES (last_insert_rowid(), ?)`);
  insertVec.run(new Float32Array(embedding));

  console.log('Querying top 1 most similar...');
  const query = db.prepare(`
    SELECT 
      chunks.rowid, 
      chunks.text_chunk,
      distance
    FROM vec_chunks
    JOIN chunks ON chunks.rowid = vec_chunks.rowid
    WHERE vec_chunks.embedding MATCH ? AND k = 1
  `);

  const results = query.all(new Float32Array(embedding));
  console.log('Result:', results);
  console.log('Setup successfully verified!');
}

main().catch(console.error);
