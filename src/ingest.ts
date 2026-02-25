import { pipeline } from '@xenova/transformers';
import { db } from './db/index.js';
import { scrapePage, closeBrowser } from './scraper.js';
import { chunkMarkdown } from './chunker.js';

async function main() {
    const url = process.argv[2];
    if (!url) {
        console.error("Usage: npx tsx src/ingest.ts <URL>");
        process.exit(1);
    }

    console.log(`[1] Scraping URL: ${url}`);
    const pageData = await scrapePage(url);
    if (!pageData || pageData.error || !pageData.markdown) {
        console.error("Scraping failed:", pageData?.error || "No markdown extracted");
        await closeBrowser();
        process.exit(1);
    }

    console.log(`[2] Scraped successfully. Title: "${pageData.title}" (${pageData.markdown.length} chars)`);

    console.log(`[3] Chunking markdown...`);
    const chunks = chunkMarkdown(pageData.markdown, 800, 100);
    console.log(`Produced ${chunks.length} chunks.`);

    console.log(`[4] Loading embedding model (all-MiniLM-L6-v2)...`);
    const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
        quantized: true,
    });

    console.log(`[5] Embedding and inserting into database...`);
    const insertChunk = db.prepare(`INSERT INTO chunks (source, text_chunk) VALUES (?, ?)`);
    const insertVec = db.prepare(`INSERT INTO vec_chunks(rowid, embedding) VALUES (last_insert_rowid(), ?)`);

    for (let i = 0; i < chunks.length; i++) {
        const chunkText = chunks[i].text;
        const enrichedText = `Source: ${pageData.title}\nURL: ${url}\n\n${chunkText}`;
        console.log(`Embedding chunk ${i + 1}/${chunks.length}... (${enrichedText.length} chars)`);

        const output = await extractor(enrichedText, { pooling: 'mean', normalize: true });
        const embedding = new Float32Array(Array.from(output.data));

        insertChunk.run(url, enrichedText);
        insertVec.run(embedding);
    }

    console.log(`[6] Verification: Querying top 1 matching nearest chunk for "${pageData.title}"...`);
    const testEmbed = await extractor(pageData.title, { pooling: 'mean', normalize: true });

    const query = db.prepare(`
        SELECT 
            chunks.rowid, 
            chunks.text_chunk,
            distance
        FROM vec_chunks
        JOIN chunks ON chunks.rowid = vec_chunks.rowid
        WHERE vec_chunks.embedding MATCH ? AND k = 1
    `);

    const results = query.all(new Float32Array(Array.from(testEmbed.data)));
    console.log('Result:', results);

    await closeBrowser();
    console.log("[7] Ingestion complete.");
}

main().catch(async (e) => {
    console.error("Ingestion error:", e);
    await closeBrowser();
});
