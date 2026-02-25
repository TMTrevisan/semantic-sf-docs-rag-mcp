# semantic-sf-docs-rag-mcp

[![npm](https://img.shields.io/npm/v/semantic-sf-docs-rag-mcp)](https://www.npmjs.com/package/semantic-sf-docs-rag-mcp)

A privacy-first, **fully local** [Model Context Protocol](https://modelcontextprotocol.io) server for semantic search over Salesforce documentation. Uses `sqlite-vec` + `all-MiniLM-L6-v2` embeddings — $0 API costs, all inference runs on your machine.

---

## Two Ways to Use It

### 🔒 Option A — Private Clone (Pre-Built Database Included)

For **personal use across machines**. Cloning gives you the full pre-embedded `rag.sqlite` plus all source PDFs — no re-ingestion needed.

```bash
git clone https://github.com/TMTrevisan/semantic-sf-docs-rag-mcp.git
cd semantic-sf-docs-rag-mcp
npm install && npm run build
```

Add to `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "semantic-sf-rag": {
      "command": "node",
      "args": ["/absolute/path/to/semantic-sf-docs-rag-mcp/dist/index.js"]
    }
  }
}
```

---

### 🌐 Option B — NPX (Public, Build Your Own DB)

For **anyone else**. Downloads the server from npm and runs against your own local database.

**Step 1 — Create a working directory and add your PDFs:**
```bash
mkdir my-sf-rag && cd my-sf-rag
mkdir pdfs
# Drop any Salesforce PDFs into ./pdfs/
```

**Step 2 — Build your local vector database (one-time):**
```bash
# Embed all PDFs in ./pdfs/ into ./rag.sqlite
npx -y semantic-sf-docs-rag-mcp-ingest-pdfs  # or run via tsx, see below
```

> For ingestion scripts, clone the repo and run:
> ```bash
> npx tsx src/ingest-pdfs.ts      # embed local PDFs
> npx tsx src/ingest.ts <url>     # scrape a Salesforce Help URL
> npx tsx src/migrate-legacy.ts   # migrate from private-sf-doc-kb
> ```

**Step 3 — Wire into Claude Desktop:**
```json
{
  "mcpServers": {
    "semantic-sf-rag": {
      "command": "npx",
      "args": ["-y", "semantic-sf-docs-rag-mcp"],
      "cwd": "/absolute/path/to/my-sf-rag"
    }
  }
}
```

The server looks for `rag.sqlite` in `cwd`. Override with `SF_DOCS_DB_PATH=/path/to/custom.sqlite`.

---

## Architecture

| Component | Technology |
|---|---|
| Embedding Model | `@xenova/transformers` · `all-MiniLM-L6-v2` (384-dim, local) |
| Vector Database | `better-sqlite3` + `sqlite-vec` extension |
| Scraping | `puppeteer-extra` + stealth + Aura API fast-path |
| MCP Protocol | `@modelcontextprotocol/sdk` over STDIO |

## Tool: `semantic_search_docs`

| Parameter | Type | Description |
|---|---|---|
| `query` | `string` | Natural language question |
| `k` | `number?` | Number of results (default: 5, max: 20) |

Returns the top-k semantically closest document chunks with source URLs and similarity percentages.
