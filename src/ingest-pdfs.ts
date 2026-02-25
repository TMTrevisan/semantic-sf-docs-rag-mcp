import fs from 'fs';
import path from 'path';
import { pipeline } from '@xenova/transformers';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pdf = require('pdf-parse');
import { db } from './db/index.js';
import { chunkMarkdown } from './chunker.js';

const PDF_DIR = path.join(process.cwd(), 'pdfs');

async function ingestLocalPdfs() {
    console.log("[1] Starting Local Offline PDF Ingestor\n");

    if (!fs.existsSync(PDF_DIR)) {
        console.log(`Created new directory at: ${PDF_DIR}`);
        fs.mkdirSync(PDF_DIR, { recursive: true });
        console.log("-> Please drop downloaded .pdf files into the 'pdfs' folder and run this script again.");
        return;
    }

    const files = fs.readdirSync(PDF_DIR).filter(f => f.toLowerCase().endsWith('.pdf'));

    if (files.length === 0) {
        console.log("No PDF files found in the 'pdfs' directory. Drop some files and retry.");
        return;
    }

    console.log(`[2] Found ${files.length} PDFs to process...\n`);

    console.log(`[3] Loading embedding model (all-MiniLM-L6-v2)...`);
    const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
        quantized: true,
    });

    const insertChunk = db.prepare(`INSERT INTO chunks (source, text_chunk) VALUES (?, ?)`);
    const insertVec = db.prepare(`INSERT INTO vec_chunks(rowid, embedding) VALUES (last_insert_rowid(), ?)`);

    let success = 0;

    for (const file of files) {
        const filePath = path.join(PDF_DIR, file);
        console.log(`Processing: ${file}`);
        try {
            const dataBuffer = fs.readFileSync(filePath);
            const data = await pdf(dataBuffer);

            const title = file.replace(/\.pdf$/i, '').replace(/_/g, ' ');
            const markdown = `# ${title}\n\n${data.text}`;

            // Build logical URI identifier
            const localUri = `file://offline/${file.replace(/\s+/g, '_')}`;

            console.log(`  -> Chunking ${data.text.length} characters...`);
            const chunks = chunkMarkdown(markdown, 800, 100);
            console.log(`  -> Generated ${chunks.length} chunks.`);

            // Insert each chunk natively using sqlite-vec
            for (let i = 0; i < chunks.length; i++) {
                const chunkText = chunks[i].text;
                const enrichedText = `Source: ${title}\nURL: ${localUri}\n\n${chunkText}`;

                const output = await extractor(enrichedText, { pooling: 'mean', normalize: true });
                const embedding = new Float32Array(Array.from(output.data));

                insertChunk.run(localUri, enrichedText);
                insertVec.run(embedding);
            }

            console.log(`  ✅ Successfully indexed into SQLite Vectors!`);
            success++;
        } catch (e: any) {
            console.error(`  ❌ Failed to parse ${file}: ${e.message}`);
        }
    }

    console.log(`\n[4] 🏁 Finished embedding ${success}/${files.length} PDFs into the SQLite Vector DB!`);
}

ingestLocalPdfs().catch(console.error);
