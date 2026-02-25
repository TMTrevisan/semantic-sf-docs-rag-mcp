import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverPath = path.join(__dirname, '../dist/index.js');

async function testSemanticSearch() {
    console.log("🚀 Initializing Local MCP Client...");

    const transport = new StdioClientTransport({
        command: 'node',
        args: [serverPath]
    });

    const client = new Client({
        name: "test-client",
        version: "1.0.0"
    }, {
        capabilities: {}
    });

    try {
        console.log("🔗 Connecting via STDIO...");
        await client.connect(transport);
        console.log("✅ Success! Server Connected.\n");

        const query = "What is Life Sciences Cloud?";
        console.log(`🤖 Invoking MCP Tool [semantic_search_docs] : "${query}"`);

        const result = await client.callTool({
            name: "semantic_search_docs",
            arguments: {
                query: query,
                k: 3
            }
        });

        console.log("\n====== Result Payload ======");
        // @ts-ignore
        result.content.forEach((chunk: any) => {
            if (chunk.type === 'text') {
                console.log(chunk.text);
                console.log("----------------------------");
            }
        });
        console.log("============================");

    } catch (error) {
        console.error("❌ MCP Integration Test Failed:", error);
    } finally {
        console.log("\n🔌 Disconnecting cleanly...");
        // @ts-ignore
        await client.close();
        process.exit(0);
    }
}

testSemanticSearch().catch(console.error);
