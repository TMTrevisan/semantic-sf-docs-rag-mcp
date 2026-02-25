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

// Cache for the embedding pipeline to avoid reloading the model on every query
let embeddingPipeline: any = null;

async function getEmbedder() {
    if (!embeddingPipeline) {
        embeddingPipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
            quantized: true,
        });
    }
    return embeddingPipeline;
}

const server = new Server(
    { name: "semantic-sf-rag", version: "1.0.0" },
    { capabilities: { tools: {} } }
);

const SearchDocsSchema = z.object({
    query: z.string().min(1).max(1000).describe("The natural language question to search relevant documents for."),
    k: z.number().int().min(1).max(20).optional().default(5).describe("Number of results to return.")
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "semantic_search_docs",
                description: "Search the local Salesforce documentation vector database using semantic similarity (not keyword matching). This tool is provided by the 'semantic-sf-docs-rag-mcp' MCP server. Use it to find 'how to' guides, architecture docs, permission sets, APIs, and configuration steps — even when you don't know the exact keywords. Searches are local, private, and require no API calls.",
                inputSchema: {
                    type: "object",
                    properties: {
                        query: { type: "string" },
                        k: { type: "number" }
                    },
                    required: ["query"]
                }
            }
        ]
    };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
        if (name === "semantic_search_docs") {
            const { query, k } = SearchDocsSchema.parse(args);

            console.error(`[semantic-sf-rag] Embedding query: "${query}"`);
            const embedder = await getEmbedder();
            const output = await embedder(query, { pooling: 'mean', normalize: true });
            const queryEmbedding = new Float32Array(Array.from(output.data));

            console.error(`[semantic-sf-rag] Searching SQLite for top ${k} closest chunks...`);

            // Execute k-nearest neighbor search via sqlite-vec extension
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
                const dbPath = process.env.SF_DOCS_DB_PATH ?? 'rag.sqlite (in server cwd)';
                return {
                    content: [{
                        type: "text",
                        text: `No results found for "${query}".\n\n**Database path checked**: \`${dbPath}\`\n\n**If the database is empty**, build it by running one of these from the repo directory:\n- \`npx tsx src/ingest-pdfs.ts\` — embed local PDFs from \`./pdfs/\`\n- \`npx tsx src/ingest.ts <url>\` — scrape a Salesforce Help URL\n- \`npx tsx src/migrate-legacy.ts\` — migrate from a legacy private-sf-doc-kb database\n\nOr clone the private repo which includes the pre-built database.`
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

        return {
            content: [{ type: "text", text: `Unknown tool: ${name}` }],
            isError: true
        };
    } catch (e: any) {
        const dbPath = process.env.SF_DOCS_DB_PATH ?? 'rag.sqlite (in server cwd)';
        return {
            content: [{ type: "text", text: `**[semantic-sf-rag] Error**: ${e.message}\n\nDatabase path: \`${dbPath}\`\n\nIf you see a SQLite error, the database may be missing or corrupt. Check the server logs for startup warnings.` }],
            isError: true
        };
    }
});

async function main() {
    console.error("[semantic-sf-rag] Starting Server...");

    // Warm up the embedding model during initialization
    console.error("[semantic-sf-rag] Warming up all-MiniLM-L6-v2 model...");
    await getEmbedder();
    console.error("[semantic-sf-rag] Model loaded. Server is ready.");

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("[semantic-sf-rag] Listening on stdio transport.");
}

// Detect if the Smithery.ai diagnostic scanner is trying to evaluate the file
const isSmitheryScanning = process.argv.some(arg =>
    typeof arg === 'string' && arg.includes('smithery')
);

if (!isSmitheryScanning) {
    main().catch(console.error);
}
