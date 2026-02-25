# Semantic Vector RAG MCP Server

A privacy-first, fully local Model Context Protocol (MCP) server that empowers LLM agents to semantically search across massive offline documentation repositories via Vector math. Designed to ingest offline Salesforce architectural PDFs and HTML Knowledge Bases effortlessly, generating zero-cost multi-dimensional mathematical text mappings.

## Prerequisites
- Node.js > 20.0
- NPM

## Installation
\`\`\`bash
npm install
npm run build
\`\`\`

## Architecture
- **Inference Engine**: \`@xenova/transformers\` (\`all-MiniLM-L6-v2\`) runs natively within the V8 JS engine, requiring $0 API costs.
- **Vector Database**: \`better-sqlite3\` enhanced with the \`sqlite-vec\` C-Extension enabling blazingly fast `vec_distance_cosine()` search mechanisms perfectly matched to standard SQL rows.

## Loading Data into the Vector DB
Before providing the server endpoint to your agent, you must ingest knowledge using one of the built-in pipelines. These orchestrators automatically invoke \`src/chunker.ts\` to divide monumental strings into <800 character contexts before invoking the local transformer embedding mapping:

### **1. Single-Page Interactive Web Scraper**
\`\`\`bash
npx tsx src/ingest.ts "https://help.salesforce.com/s/articleView?id=ind.lsc_customer_engagement_get_org_ready.htm..."
\`\`\`
Extracts and seamlessly embeds the given web URL via Puppeteer stealth masking and Aura API interception.

### **2. Local PDF Ingestion**
\`\`\`bash
npx tsx src/ingest-pdfs.ts
\`\`\`
Scans the \`pdfs/\` standard directory and iterates through massive offline developer manuals (e.g. 500+ pages), securely routing them through \`pdf-parse\` layer extraction into offline Vectors.

### **3. Legacy Database Migration**
\`\`\`bash
npx tsx src/migrate-legacy.ts
\`\`\`
Transforms historical Knowledge-Base extractions mapping V1 \`documents\` and \`chunks\` joins directly into the optimized V2 mathematical space without fetching from the web.

## Running the Server
You can launch the Model Context Protocol endpoint securely across any standard LLM client configured for STDIO:
\`\`\`bash
node dist/index.js
\`\`\`

## Using with standard MCP Clients (e.g., Claude)
Point your client configuration directly to the built application path:

**claude_desktop_config.json**
\`\`\`json
{
  "mcpServers": {
    "semantic-sf-rag": {
      "command": "node",
      "args": ["/absolute/path/to/semantic-sf-docs-rag-mcp/dist/index.js"]
    }
  }
}
\`\`\`

## Tool Specifications
Provides the \`semantic_search_docs\` tool natively to your agent network.

**Parameters:**
- \`query\`: A natural-language sentence or multi-part question (e.g. "How do I secure patient records using OmniStudio?").
- \`k\`: Optional integer. The distinct number of multi-dimensional chunks you want the matching algorithm to aggregate.

## Synchronization & Git Storage
The embedded output structure sits within \`rag.sqlite\`. This project is intentionally configured via \`.gitignore\` to push the entire pre-embedded Vector database (and any PDF resources) up to a private Github repository. You will not need to re-execute data ingestion on alternate system configurations when cloning!
