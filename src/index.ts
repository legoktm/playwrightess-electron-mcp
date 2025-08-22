#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as vm from "node:vm";
import * as playwright from "playwright";
import { createRequire } from "node:module";
import assert from "node:assert";
import { SingleBrowserSessionManager } from "./session-manager.js";
import { parse } from "@babel/parser";
import traverse, { NodePath } from "@babel/traverse";
// @ts-ignore
const traverseDefault = traverse.default || traverse;
import * as t from "@babel/types";
import generate from "@babel/generator";
// @ts-ignore
const generateDefault = generate.default || generate;

const TRACKED_VARIABLES = new Set([
  "page",
  "browser",
  "context",
  "sessionManager",
]);

function rewriteCodeToTrackVariables(code: string): string {
  try {
    const ast = parse(code, {
      sourceType: "module",
      allowImportExportEverywhere: true,
      allowAwaitOutsideFunction: true,
      plugins: ["typescript", "jsx"],
    });

    traverseDefault(ast, {
      VariableDeclarator(path: NodePath<t.VariableDeclarator>) {
        const id = path.node.id;
        if (t.isIdentifier(id) && TRACKED_VARIABLES.has(id.name)) {
          const assignment = t.assignmentExpression(
            "=",
            t.memberExpression(
              t.identifier("globalThis"),
              t.identifier(id.name)
            ),
            t.identifier(id.name)
          );
          const expressionStatement = t.expressionStatement(assignment);

          const parent = path.getFunctionParent() || path.getStatementParent();
          if (parent) {
            parent.insertAfter(expressionStatement);
          }
        }
      },

      AssignmentExpression(path: NodePath<t.AssignmentExpression>) {
        const left = path.node.left;
        if (t.isIdentifier(left) && TRACKED_VARIABLES.has(left.name)) {
          const globalAssignment = t.assignmentExpression(
            "=",
            t.memberExpression(
              t.identifier("globalThis"),
              t.identifier(left.name)
            ),
            t.identifier(left.name)
          );
          const expressionStatement = t.expressionStatement(globalAssignment);

          const parent = path.getStatementParent();
          if (parent) {
            parent.insertAfter(expressionStatement);
          }
        }
      },
    });

    return generateDefault(ast).code;
  } catch (error) {
    console.error("AST parsing/rewriting failed:", error);
    return code;
  }
}

class PlaywrightMCPServer {
  private server: Server;
  private context!: vm.Context;
  private isInitialized = false;
  private sessionManager: SingleBrowserSessionManager;
  private consoleMessages: string[] = [];
  private sessionConsoleMessages: string[] = [];
  private consoleHandlerRegistered = false;

  constructor() {
    this.sessionManager = SingleBrowserSessionManager.getInstance();
    this.server = new Server(
      {
        name: "playwrightess-mcp",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  async initialize() {
    await this.initializeContext();
  }

  private async initializeContext() {
    // Create a persistent VM context with Node.js built-ins and Playwright modules
    // but delay actual browser/context/page initialization until first use
    const require = createRequire(import.meta.url);

    // Create a patched console that captures session console calls
    const sessionConsole = {
      log: (...args: any[]) => {
        const message = args
          .map((arg) =>
            typeof arg === "object" ? JSON.stringify(arg) : String(arg)
          )
          .join(" ");
        this.sessionConsoleMessages.push(`[LOG] ${message}`);
        console.log(...args);
      },
      warn: (...args: any[]) => {
        const message = args
          .map((arg) =>
            typeof arg === "object" ? JSON.stringify(arg) : String(arg)
          )
          .join(" ");
        this.sessionConsoleMessages.push(`[WARN] ${message}`);
        console.warn(...args);
      },
      error: (...args: any[]) => {
        const message = args
          .map((arg) =>
            typeof arg === "object" ? JSON.stringify(arg) : String(arg)
          )
          .join(" ");
        this.sessionConsoleMessages.push(`[ERROR] ${message}`);
        console.error(...args);
      },
      info: (...args: any[]) => {
        const message = args
          .map((arg) =>
            typeof arg === "object" ? JSON.stringify(arg) : String(arg)
          )
          .join(" ");
        this.sessionConsoleMessages.push(`[INFO] ${message}`);
        console.info(...args);
      },
      debug: (...args: any[]) => {
        const message = args
          .map((arg) =>
            typeof arg === "object" ? JSON.stringify(arg) : String(arg)
          )
          .join(" ");
        this.sessionConsoleMessages.push(`[DEBUG] ${message}`);
        console.debug(...args);
      },
    };

    const contextObject = {
      // Node.js built-ins - using patched console
      console: sessionConsole,
      setTimeout,
      setInterval,
      clearTimeout,
      clearInterval,
      Buffer,
      process,
      require,

      // Playwright modules
      playwright,
      chromium: playwright.chromium,
      firefox: playwright.firefox,
      webkit: playwright.webkit,
      devices: playwright.devices,

      // Session manager for advanced operations
      sessionManager: this.sessionManager,

      // Global state object for user variables
      sharedState: {},

      // Other commonly used modules
      assert,
    };

    this.context = vm.createContext(contextObject);
    this.isInitialized = true;

    vm.runInContext(
      "const global = globalThis; const self = globalThis;",
      this.context
    );
  }

  private async ensurePlaywrightInitialized() {
    // Check if Playwright instances are already available in the context
    const browser = vm.runInContext(
      "typeof browser !== 'undefined' ? browser : null",
      this.context
    );
    const context = vm.runInContext(
      "typeof context !== 'undefined' ? context : null",
      this.context
    );
    const page = vm.runInContext(
      "typeof page !== 'undefined' ? page : null",
      this.context
    );

    if (!browser || !context || !page) {
      // Initialize session manager instances
      const browserInstance = await this.sessionManager.ensureBrowser();
      const contextInstance = await this.sessionManager.ensureContext();
      const pageInstance = await this.sessionManager.ensurePage();

      // Add them to the VM context
      this.context.browser = browserInstance;
      this.context.context = contextInstance;
      this.context.page = pageInstance;

      vm.runInContext(
        `
        globalThis.browser = browser;
        globalThis.context = context;
        globalThis.page = page;
      `,
        this.context
      );

      // Register console handler for the page
      this.registerConsoleHandler(pageInstance);
    }
  }

  private registerConsoleHandler(page: playwright.Page) {
    if (!this.consoleHandlerRegistered) {
      page.on("console", (msg) => {
        this.consoleMessages.push(msg.text());
      });
      this.consoleHandlerRegistered = true;
    }
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: "playwright_eval",
            description: [
              "Evaluate JavaScript code (supports await) in a persistent Playwright context.",
              "Variables sharedState, browser, context, page are maintained between evaluations, others are lost.",
              "To accumulate data, put it into sharedState.",
              "Place screenshots in temp folder",
              "DO NOT USE waitForLoadState('networkidle') or waitForSelector",
              "DO NOT CODE COMMENTS OR WHITSPACE",
            ].join("\n"),
            inputSchema: {
              type: "object",
              properties: {
                code: {
                  type: "string",
                  description: "JavaScript code to evaluate",
                },
              },
              required: ["code"],
            },
          },
        ],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name !== "playwright_eval") {
        throw new Error(`Unknown tool: ${request.params.name}`);
      }

      const { code } = request.params.arguments as { code: string };

      if (!this.isInitialized) {
        throw new Error("Server not properly initialized");
      }

      try {
        // Ensure Playwright is initialized before executing code
        await this.ensurePlaywrightInitialized();

        // Rewrite the code to track variable assignments
        const rewrittenCode = rewriteCodeToTrackVariables(code);

        // Wrap the rewritten code in an async IIFE to support top-level await
        const wrappedCode = `(async () => {
  ${rewrittenCode}
})()`;

        // Execute the wrapped code in the persistent context
        const result = vm.runInContext(wrappedCode, this.context);

        // The result will always be a Promise due to the async wrapper
        const finalResult = await result;

        // Capture console log messages and clear them
        const browserConsoleLog = [...this.consoleMessages];
        const sessionConsoleLog = [...this.sessionConsoleMessages];
        this.consoleMessages.length = 0;
        this.sessionConsoleMessages.length = 0;

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                result: finalResult !== undefined ? finalResult : "undefined",
                browserConsoleLog,
                sessionConsoleLog,
              }),
            },
          ],
        };
      } catch (error) {
        // Capture console log messages and clear them even on error
        const browserConsoleLog = [...this.consoleMessages];
        const sessionConsoleLog = [...this.sessionConsoleMessages];
        this.consoleMessages.length = 0;
        this.sessionConsoleMessages.length = 0;

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                browserConsoleLog,
                sessionConsoleLog,
              }),
            },
          ],
        };
      }
    });
  }

  async run() {
    await this.initialize();
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Playwrightess MCP server running on stdio");
  }
}

const server = new PlaywrightMCPServer();

process.on("SIGINT", async () => {
  console.error("Gracefully shutting down...");
  const sessionManager = SingleBrowserSessionManager.getInstance();
  await sessionManager.saveStorageState();
  await sessionManager.cleanup();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.error("Gracefully shutting down...");
  const sessionManager = SingleBrowserSessionManager.getInstance();
  await sessionManager.saveStorageState();
  await sessionManager.cleanup();
  process.exit(0);
});

server.run().catch(console.error);
