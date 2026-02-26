# semantic-sf-docs-rag-mcp

[![npm](https://img.shields.io/npm/v/semantic-sf-docs-rag-mcp)](https://www.npmjs.com/package/semantic-sf-docs-rag-mcp)

A privacy-first, **fully local** [Model Context Protocol](https://modelcontextprotocol.io) server for semantic search over Salesforce documentation. Uses `sqlite-vec` + `all-MiniLM-L6-v2` embeddings — **$0 API costs**, all inference runs on your machine.

---

## Quick Start (Local Build)

```bash
git clone https://github.com/TMTrevisan/semantic-sf-docs-rag-mcp.git
cd semantic-sf-docs-rag-mcp
npm install && npm run build
```

**Build the vector database (one-time, ~20-45 min):**
```bash
# Drop any Salesforce PDFs into ./pdfs/, then embed them:
npx tsx src/ingest-pdfs.ts

# Or scrape a single Salesforce Help URL:
npx tsx src/ingest.ts <url>
```

**Wire into Claude Desktop (`claude_desktop_config.json`):**
```json
{
  "mcpServers": {
    "semantic-sf-rag": {
      "command": "node",
      "args": ["/absolute/path/to/semantic-sf-docs-rag-mcp/dist/index.js"],
      "env": {
        "SF_DOCS_DB_PATH": "/absolute/path/to/semantic-sf-docs-rag-mcp/rag.sqlite"
      }
    }
  }
}
```

> **Tip:** The embedding model (`all-MiniLM-L6-v2`, ~80MB) is automatically downloaded and cached to `~/.cache/huggingface/` on first run. No API key needed.

---

## Architecture

| Component | Technology |
|---|---|
| Embedding Model | `@xenova/transformers` · `all-MiniLM-L6-v2` (384-dim, local ONNX) |
| Vector Database | `better-sqlite3` + `sqlite-vec` extension |
| Scraping | `puppeteer-extra` + stealth + Aura API fast-path |
| MCP Protocol | `@modelcontextprotocol/sdk` over STDIO |

## Tool: `semantic_search_docs`

| Parameter | Type | Description |
|---|---|---|
| `query` | `string` | Natural language question — no exact keywords needed |
| `k` | `number?` | Number of results (default: 5, max: 20) |

Returns the top-k semantically closest document chunks with source URLs and similarity percentages.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `SF_DOCS_DB_PATH` | `./rag.sqlite` in cwd | Absolute path to your vector database file |
