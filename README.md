# Playwrightess MCP

An MCP (Model Context Protocol) server that provides a persistent Playwright evaluation environment.

## Features

- Single tool: `playwright_eval` - evaluates JavaScript code in a persistent Playwright context
- Maintains state between evaluations (browser, context, page variables persist)
- Pre-loaded with Playwright modules and common Node.js built-ins
- Supports step-by-step script execution

## Installation

```bash
npm install
npm run build
```

## Usage

Start the MCP server:

```bash
npm start
```

### Example Usage

You can send JavaScript code to be evaluated step by step:

```javascript
// Setup
browser = await chromium.launch();
context = await browser.newContext(devices['iPhone 11']);
page = await context.newPage();
```

```javascript
// Navigation and interaction
await page.goto('https://example.com/');
const title = await page.title();
console.log('Page title:', title);
```

```javascript
// Teardown (when done)
await context.close();
await browser.close();
```

## Tool Schema

- **Name**: `playwright_eval`
- **Input**: 
  - `code` (string): JavaScript code to evaluate
- **Output**: JSON with execution result or error details