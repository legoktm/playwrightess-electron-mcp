# Playwrightess MCP for Electron

An MCP (Model Context Protocol) server that provides a persistent Playwright evaluation environment for Electron applications.

This is a fork of Armin Ronacher's [playwrightess-mcp](https://github.com/mitsuhiko/playwrightess-mcp), taking the same approach
but for Electron applications.

Unlike the normal playwright-mcp, this exposes a JavaScript programming interface with persistence between calls. This allows
the agent to write against the Playwright API with a single ubertool called `playwright_eval`.


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

With Claude Code:

```bash
$ claude mcp add playwrightess-electron node /path/to/dist/index.js
```

## Usage with Electron

1. First, configure Electron app by calling:
```javascript
sessionManager.setElectronMode('/path/to/electron', ['/path/to/main.js'])
```

2. Then use the standard Playwright API. The `electronApp`, `context`, and `page` variables will be available:
```javascript
// Example: Launch SecureDrop client
sessionManager.setElectronMode('electron', ['/home/user/securedrop-client/app/out/main/index.js'])
await page.waitForLoadState('load')
const title = await page.title()
await page.screenshot({ path: '/tmp/screenshot.png' })
```

## Persistent Variables

The following variables persist between `playwright_eval` calls:
- `sharedState` - Object for storing custom data
- `electronApp` - The Electron application instance
- `context` - The browser context
- `page` - The current page/window
- `sessionManager` - The session manager for configuration

## License

This is built with Claude and might not be copyrightable.  Otherwise consider it Apache 2.0.

- License: [Apache-2.0](https://github.com/mitsuhiko/playwrightess-mcp/blob/main/LICENSE)
