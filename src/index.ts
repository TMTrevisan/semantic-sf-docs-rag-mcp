#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { pipeline } from '@xenova/transformers';
import { db } from './db/index.js';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Prefer the locally bundled model so HuggingFace is never contacted.
// Falls back to online download if the bundle is missing (e.g. fresh clone without LFS).
const LOCAL_MODEL_PATH = path.join(__dirname, '../models/Xenova/all-MiniLM-L6-v2');
const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

// Cache for the embedding pipeline to avoid reloading the model on every query
let embeddingPipeline: any = null;

async function getEmbedder() {
    if (!embeddingPipeline) {
        const { existsSync } = await import('fs');
        const modelSource = existsSync(LOCAL_MODEL_PATH) ? LOCAL_MODEL_PATH : MODEL_ID;
        console.error(`[semantic-sf-rag] Loading model from: ${modelSource}`);
        embeddingPipeline = await pipeline('feature-extraction', modelSource, {
            quantized: true,
        });
    }
    return embeddingPipeline;
}

const server = new Server(
    { name: "semantic-sf-rag", version: "2.0.0" },
    { capabilities: { tools: {} } }
);

// ── Schemas ──────────────────────────────────────────────────────────────────

const SearchDocsSchema = z.object({
    query: z.string().min(1).max(1000).describe("The natural language question to search relevant documents for."),
    k: z.number().int().min(1).max(20).optional().default(5).describe("Number of results to return.")
});

const GetSourceContentSchema = z.object({
    source: z.string().min(1).describe("The source identifier (URL or file path) to retrieve all chunks from."),
    limit: z.number().int().min(1).max(100).optional().default(20).describe("Max chunks to return.")
});

const AddPdfSchema = z.object({
    file_path: z.string().min(1).describe("Absolute path to a local PDF file to embed and add to the index.")
});

// ── Tool Definitions ──────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "semantic_search_docs",
                description: "Search the Salesforce documentation vector database using semantic similarity (not keyword matching). Finds conceptually related content even when exact keywords differ. Covers Life Sciences Cloud, Sales Cloud, Health Cloud, CPQ, DevOps Center, and more. $0 API cost — all inference is local.",
                inputSchema: {
                    type: "object",
                    properties: {
                        query: { type: "string", description: "Natural language question or topic." },
                        k: { type: "number", description: "Number of results (default: 5, max: 20)." }
                    },
                    required: ["query"]
                }
            },
            {
                name: "list_doc_sources",
                description: "List all Salesforce PDF documents and web pages currently indexed in the vector database, with chunk counts per source.",
                inputSchema: { type: "object", properties: {} }
            },
            {
                name: "get_source_content",
                description: "Retrieve all indexed chunks from a specific Salesforce document by its source identifier (URL or file path). Use after list_doc_sources to deep-dive into a specific document.",
                inputSchema: {
                    type: "object",
                    properties: {
                        source: { type: "string", description: "Source identifier from list_doc_sources." },
                        limit: { type: "number", description: "Max chunks to return (default: 20)." }
                    },
                    required: ["source"]
                }
            },
            {
                name: "add_pdf_to_index",
                description: "Embed a local PDF file into the Salesforce documentation vector database. Use this to extend the knowledge base with additional PDFs without re-running the full ingest pipeline.",
                inputSchema: {
                    type: "object",
                    properties: {
                        file_path: { type: "string", description: "Absolute path to the PDF file on your local machine." }
                    },
                    required: ["file_path"]
                }
            }
        ]
    };
});

// ── Tool Handlers ─────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
        // ── semantic_search_docs ──────────────────────────────────────────────
        if (name === "semantic_search_docs") {
            const { query, k } = SearchDocsSchema.parse(args);

            console.error(`[semantic-sf-rag] Embedding query: "${query}"`);
            const embedder = await getEmbedder();
            const output = await embedder(query, { pooling: 'mean', normalize: true });
            const queryEmbedding = new Float32Array(Array.from(output.data));

            console.error(`[semantic-sf-rag] Searching for top ${k} closest chunks...`);

            const searchStmt = db.prepare(`
                SELECT 
                    chunks.source, 
                    chunks.text_chunk,
                    vec_distance_cosine(vec_chunks.embedding, ?) as distance
                FROM vec_chunks
                JOIN chunks ON chunks.rowid = vec_chunks.rowid
                WHERE vec_chunks.embedding MATCH ? AND k = ?
                ORDER BY distance ASC
            `);

            const results = searchStmt.all(queryEmbedding, queryEmbedding, k) as Array<{ source: string, text_chunk: string, distance: number }>;

            if (results.length === 0) {
                return {
                    content: [{
                        type: "text",
                        text: `No results found for "${query}".\n\n**Database has no indexed documents yet.**\n\nTo populate it:\n- Drop PDFs into the \`pdfs/\` folder and run: \`npm run ingest-pdfs\`\n- Or run: \`npm run ingest-url <salesforce-help-url>\``
                    }]
                };
            }

            let outputText = `# Semantic Search Results for "${query}"\n\n`;
            for (let i = 0; i < results.length; i++) {
                const r = results[i];
                const similarityScore = (1 - r.distance) * 100;
                outputText += `## Result ${i + 1} (Similarity: ${similarityScore.toFixed(1)}%)\n`;
                outputText += `**Source**: ${r.source}\n\n`;
                outputText += `${r.text_chunk}\n\n---\n`;
            }
            return { content: [{ type: "text", text: outputText }] };
        }

        // ── list_doc_sources ─────────────────────────────────────────────────
        if (name === "list_doc_sources") {
            const rows = db.prepare(`
                SELECT source, COUNT(*) as chunk_count 
                FROM chunks 
                GROUP BY source 
                ORDER BY chunk_count DESC
            `).all() as Array<{ source: string, chunk_count: number }>;

            const total = db.prepare(`SELECT COUNT(*) as n FROM chunks`).get() as { n: number };

            if (rows.length === 0) {
                return { content: [{ type: "text", text: "No documents indexed yet. Run `npm run ingest-pdfs` to populate the database." }] };
            }

            let text = `# Indexed Salesforce Documentation Sources\n\n`;
            text += `**Total:** ${rows.length} sources · ${total.n.toLocaleString()} chunks\n\n`;
            text += `| # | Source | Chunks |\n|---|--------|--------|\n`;
            rows.forEach((r, i) => {
                const label = r.source.replace('file://offline/', '').replace(/^https?:\/\//, '');
                text += `| ${i + 1} | ${label} | ${r.chunk_count} |\n`;
            });
            return { content: [{ type: "text", text }] };
        }

        // ── get_source_content ───────────────────────────────────────────────
        if (name === "get_source_content") {
            const { source, limit } = GetSourceContentSchema.parse(args);

            const rows = db.prepare(`
                SELECT text_chunk FROM chunks 
                WHERE source LIKE ? 
                LIMIT ?
            `).all(`%${source}%`, limit) as Array<{ text_chunk: string }>;

            if (rows.length === 0) {
                return { content: [{ type: "text", text: `No chunks found for source matching: "${source}"` }] };
            }

            let text = `# Content from: ${source}\n\n*(${rows.length} chunks)*\n\n---\n\n`;
            rows.forEach((r, i) => { text += `### Chunk ${i + 1}\n${r.text_chunk}\n\n---\n`; });
            return { content: [{ type: "text", text }] };
        }

        // ── add_pdf_to_index ─────────────────────────────────────────────────
        if (name === "add_pdf_to_index") {
            const { file_path } = AddPdfSchema.parse(args);
            const { existsSync, readFileSync } = await import('fs');
            const { createRequire } = await import('module');
            const req = createRequire(import.meta.url);

            if (!existsSync(file_path)) {
                return { content: [{ type: "text", text: `File not found: ${file_path}` }], isError: true };
            }

            console.error(`[semantic-sf-rag] Ingesting PDF: ${file_path}`);
            const pdfParse = req('pdf-parse');
            const buffer = readFileSync(file_path);
            const data = await pdfParse(buffer);

            const fileName = path.basename(file_path);
            const title = fileName.replace(/\.pdf$/i, '').replace(/_/g, ' ');
            const localUri = `file://offline/${fileName.replace(/\s+/g, '_')}`;

            // Simple chunking
            const CHUNK_SIZE = 800;
            const text = data.text || '';
            const chunks: string[] = [];
            for (let i = 0; i < text.length; i += CHUNK_SIZE - 100) {
                chunks.push(`Source: ${title}\nURL: ${localUri}\n\n${text.slice(i, i + CHUNK_SIZE)}`);
            }

            const embedder = await getEmbedder();
            const insertChunk = db.prepare(`INSERT INTO chunks (source, text_chunk) VALUES (?, ?)`);
            const insertVec = db.prepare(`INSERT INTO vec_chunks(rowid, embedding) VALUES (last_insert_rowid(), ?)`);

            let indexed = 0;
            for (const chunk of chunks) {
                const out = await embedder(chunk, { pooling: 'mean', normalize: true });
                const embedding = new Float32Array(Array.from(out.data));
                insertChunk.run(localUri, chunk);
                insertVec.run(embedding);
                indexed++;
            }

            return {
                content: [{
                    type: "text",
                    text: `✅ Successfully indexed **${fileName}**\n- Chunks created: ${indexed}\n- Source ID: \`${localUri}\`\n\nYou can now search its content with \`semantic_search_docs\`.`
                }]
            };
        }

        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };

    } catch (e: any) {
        return {
            content: [{ type: "text", text: `**[semantic-sf-rag] Error**: ${e.message}` }],
            isError: true
        };
    }
});

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    console.error("[semantic-sf-rag] Starting Server v2.0.0...");
    console.error("[semantic-sf-rag] Embedding model will load on first query.");
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("[semantic-sf-rag] Listening on stdio transport.");
}

const isSmitheryScanning = process.argv.some(arg =>
    typeof arg === 'string' && arg.includes('smithery')
);

if (!isSmitheryScanning) {
    main().catch(console.error);
}
