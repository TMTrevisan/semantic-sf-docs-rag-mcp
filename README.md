# Semantic Vector RAG MCP Server

A privacy-first, fully **local** Model Context Protocol (MCP) server that gives LLM agents semantic search over Salesforce documentation via vector embeddings. Zero API costs — all inference runs locally with `@xenova/transformers`.

## Quick Start (NPX — Public)

> **No database included.** You build your own local vector index using the ingestion scripts below.

```bash
# 1. Create a working directory and initialize a local database
mkdir my-sf-rag && cd my-sf-rag

# 2. Drop any Salesforce PDFs you have into a pdfs/ subfolder
mkdir pdfs
# copy your PDFs here...

# 3. Ingest PDFs into the local vector database (runs once)
npx semantic-sf-docs-rag-mcp ingest-pdfs

# 4. Wire the server into your agent (e.g. Claude Desktop)
# Add to claude_desktop_config.json:
```

```json
{
  "mcpServers": {
    "semantic-sf-rag": {
      "command": "npx",
      "args": ["-y", "semantic-sf-docs-rag-mcp"],
      "cwd": "/path/to/my-sf-rag"
    }
  }
}
```

The server automatically looks for `rag.sqlite` in your working directory (`cwd`).  
Override the path with the `SF_DOCS_DB_PATH` env var if needed.

---

## Private Clone (Full Pre-Embedded Database)

> Clone this approach to get the **full pre-built database** with all embedded PDFs — no re-ingestion needed.

```bash
git clone https://github.com/TMTrevisan/semantic-sf-docs-rag-mcp.git
cd semantic-sf-docs-rag-mcp
npm install
npm run build
```

The cloned `rag.sqlite` contains all pre-computed vector embeddings. Just point Claude Desktop at it:

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

## Data Ingestion Scripts

Run any of these from your working directory to build or expand the local `rag.sqlite` database:

| Command | What it does |
|---|---|
| `npx tsx src/ingest.ts <url>` | Scrape a single Salesforce Help page & embed it |
| `npx tsx src/ingest-pdfs.ts` | Embed all `.pdf` files from a local `pdfs/` folder |
| `npx tsx src/migrate-legacy.ts` | Migrate from a legacy `private-sf-doc-kb/salesforce-docs.db` |

---

## Architecture

| Component | Technology |
|---|---|
| Embedding Model | `@xenova/transformers` · `all-MiniLM-L6-v2` (384-dim, local) |
| Vector Database | `better-sqlite3` + `sqlite-vec` extension |
| Scraping | `puppeteer-extra` + stealth plugin + Aura API fast-path |
| MCP Protocol | `@modelcontextprotocol/sdk` over STDIO |

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `SF_DOCS_DB_PATH` | `./rag.sqlite` | Override the database file location |

## How it works

1. On query, the server embeds the question locally into a 384-float vector
2. `sqlite-vec` runs `vec_distance_cosine()` kNN search over the pre-indexed chunks
3. Top-k results (source URL + context text + similarity %) are returned as Markdown
