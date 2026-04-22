# Lido MCP Server

MCP server for the [Lido](https://lido.app) data extraction API. Exposes four tools to any MCP-compatible agent:

- `authenticate` — sign in on first use (opens a browser to paste your Lido API key)
- `extract_file_data` — extract structured data from a document (PDF, image, etc.) into named columns
- `extraction_tips` — advanced refinement techniques the agent can consult when an extraction doesn't come out right
- `extractor_usage` — check your Lido page quota

## Install

**Claude Code:**

```bash
claude mcp add lido -- npx -y @lido-app/mcp-server
```

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "lido": {
      "command": "npx",
      "args": ["-y", "@lido-app/mcp-server"]
    }
  }
}
```

Any other MCP client that supports stdio servers works the same way — launch `npx -y @lido-app/mcp-server`.

## Usage

On first use, ask the agent to sign you in — it will call `authenticate`, which opens a browser to the Lido authorization page where you paste your API key. The key is saved per-project under `<project-root>/.lido-mcp/credentials.json` (automatically gitignored) and reused on future runs.

Then just ask things like:

- *"Extract the invoice number, total, and due date from `./invoice.pdf`"*
- *"How many Lido pages do I have left this month?"*

## License

MIT
