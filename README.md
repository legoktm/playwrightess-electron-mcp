# Playwrightess MCP

An MCP (Model Context Protocol) server that provides a persistent Playwright evaluation environment.

Unlike Playwright MCP this takes a very different approach.  It exposes a JavaScript progrmaming
interface with persistence between calls.  This allows the agent to write against the playwright
API with a single ubertool called `playwright_eval`.

This is an experiment and intentionally not published.

## Installation

```bash
npm install
npm run build
```

## Usage

Configure the MCP server:

```bash
{
  "mcpServers": {
    "playwriter-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/dist/index.js"],
      "env": {}
    }
  }
}
```

## License

This is built with Claude and might not be copyrightable.  Otherwise consider it Apache 2.0.

- License: [Apache-2.0](https://github.com/mitsuhiko/playwrightess-mcp/blob/main/LICENSE)
