import Database from 'better-sqlite3';
import { pipeline } from '@xenova/transformers';
import { db as newDb } from './db/index.js';
import { chunkMarkdown } from './chunker.js';

async function migrateLegacyDB() {
    console.log("[1] Connecting to Legacy Database (salesforce-docs.db)...");

    // Provide absolute or relative path to the legacy database file
    const legacyDbPath = '../private-sf-doc-kb/salesforce-docs.db';
    let legacyDb;
    try {
        legacyDb = new Database(legacyDbPath, { readonly: true });
    } catch (err: any) {
        console.error(`Failed to open legacy database at ${legacyDbPath}: ${err.message}`);
        return;
    }

    const stmt = legacyDb.prepare(`
        SELECT d.url, d.title, c.content
        FROM chunks c
        JOIN documents d ON d.id = c.document_id
    `);
    const legacyChunks = stmt.all() as Array<{ url: string, title: string, content: string }>;

    console.log(`[2] Found ${legacyChunks.length} existing Legacy Chunks.\n`);

    if (legacyChunks.length === 0) {
        console.log("Legacy database is empty.");
        return;
    }

    console.log(`[3] Loading embedding model (all-MiniLM-L6-v2)...`);
    const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
        quantized: true,
    });

    const insertChunk = newDb.prepare(`INSERT INTO chunks (source, text_chunk) VALUES (?, ?)`);
    const insertVec = newDb.prepare(`INSERT INTO vec_chunks(rowid, embedding) VALUES (last_insert_rowid(), ?)`);

    console.log(`[4] Beginning Migration & Embedding...\n`);

    let success = 0;

    // Process fully all existing chunks!
    for (let i = 0; i < legacyChunks.length; i++) {
        const doc = legacyChunks[i];
        console.log(`Translating Legacy Chunk ${i + 1}/${legacyChunks.length}: "${doc.title}"`);

        try {
            const enrichedText = `Source: ${doc.title}\nURL: ${doc.url}\n\n${doc.content}`;
            const output = await extractor(enrichedText, { pooling: 'mean', normalize: true });
            const embedding = new Float32Array(Array.from(output.data));

            // Save natively into sqlite-vec structures
            insertChunk.run(doc.url, enrichedText);
            insertVec.run(embedding);
            success++;
        } catch (e: any) {
            console.error(`  ❌ Failed to migrate ${doc.url}: ${e.message}`);
        }
    }

    console.log(`\n[5] 🏁 Successfully chunked, embedded, and mapped ${success}/${legacyChunks.length} legacy documents to Virtual math coordinates!`);
}

migrateLegacyDB().catch(console.error);
