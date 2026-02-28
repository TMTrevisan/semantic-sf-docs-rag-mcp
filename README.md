# semantic-sf-docs-rag-mcp

[![npm](https://img.shields.io/npm/v/semantic-sf-docs-rag-mcp)](https://www.npmjs.com/package/semantic-sf-docs-rag-mcp)

A privacy-first, **fully local** [Model Context Protocol](https://modelcontextprotocol.io) server for semantic search over Salesforce documentation. Uses `sqlite-vec` + `all-MiniLM-L6-v2` embeddings — **$0 API costs**, no data leaves your machine.

Ships with a pre-populated vector database and bundled ONNX model — **zero configuration required**.

---

## Quick Start — npx (Recommended)

No install needed. Add to your MCP client config and it runs automatically.

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (Mac) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "sf-docs": {
      "command": "npx",
      "args": ["-y", "semantic-sf-docs-rag-mcp@latest"]
    }
  }
}
```

### VS Code Agentforce Vibes

Add to `.vscode/mcp.json` in your workspace (or User Settings → MCP):

```json
{
  "servers": {
    "sf-docs": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "semantic-sf-docs-rag-mcp@latest"]
    }
  }
}
```

> **Windows users:** VS Code may not inherit PATH. Use the full path to Node if needed:
> ```json
> "command": "C:\\Program Files\\nodejs\\node.exe",
> "args": ["C:\\Users\\YOU\\.npm-cache\\semantic-sf-docs-rag-mcp\\dist\\index.js"]
> ```

Restart Claude / reload VS Code. The `semantic_search_docs` tool is now available.

---

## Available MCP Tools

| Tool | Description |
|---|---|
| `semantic_search_docs` | Semantic similarity search across indexed Salesforce docs |
| `list_doc_sources` | List all indexed documents with chunk counts |
| `get_source_content` | Retrieve all chunks from a specific document |
| `add_pdf_to_index` | Embed a local PDF into the database at runtime |

---

## Architecture

| Component | Technology |
|---|---|
| Embedding Model | `@xenova/transformers` · `all-MiniLM-L6-v2` (384-dim, local ONNX, ~22MB) |
| Vector Database | `better-sqlite3` + `sqlite-vec` — ships as `data/rag.sqlite` |
| MCP Protocol | `@modelcontextprotocol/sdk` over STDIO |

---

## Extending the Database with Your Own PDFs

The bundled database covers a curated set of Salesforce documentation. To add your own content:

### Option 1 — Drop PDFs and run the ingest script

```bash
# Clone the repo
git clone https://github.com/TMTrevisan/semantic-sf-docs-rag-mcp.git
cd semantic-sf-docs-rag-mcp
npm install

# Add your PDF files
cp ~/Downloads/MyCustomDoc.pdf ./pdfs/

# Run the ingest (embeds all PDFs in ./pdfs/)
npm run ingest-pdfs
```

The script will:
- Parse text from each PDF
- Split into overlapping 800-character chunks
- Generate `all-MiniLM-L6-v2` embeddings locally
- Store everything in `data/rag.sqlite`

Point your MCP config at the local `dist/index.js` to use your custom database:

```json
{
  "mcpServers": {
    "sf-docs": {
      "command": "node",
      "args": ["/path/to/semantic-sf-docs-rag-mcp/dist/index.js"]
    }
  }
}
```

> The server always loads `data/rag.sqlite` relative to its own install location. Override with the `SF_DOCS_DB_PATH` environment variable if needed.

### Option 2 — Add a PDF at runtime via MCP tool

Ask your AI assistant to index a specific PDF without restarting the server:

```
Use the add_pdf_to_index tool to embed /Users/me/Downloads/AgentforceDocs.pdf
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `SF_DOCS_DB_PATH` | `data/rag.sqlite` next to the package | Override the database path |
