#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import * as vm from 'node:vm';
import * as playwright from 'playwright';
import { createRequire } from 'node:module';
import assert from 'node:assert';
import { SingleBrowserSessionManager } from './session-manager.js';
import { parse } from '@babel/parser';
import traverse, { NodePath } from '@babel/traverse';
// @ts-ignore
const traverseDefault = traverse.default || traverse;
import * as t from '@babel/types';
import generate from '@babel/generator';
// @ts-ignore
const generateDefault = generate.default || generate;

const TRACKED_VARIABLES = new Set(['page', 'browser', 'context', 'sessionManager']);

function rewriteCodeToTrackVariables(code: string): string {
  try {
    const ast = parse(code, {
      sourceType: 'module',
      allowImportExportEverywhere: true,
      allowAwaitOutsideFunction: true,
      plugins: ['typescript', 'jsx']
    });

    traverseDefault(ast, {
      VariableDeclarator(path: NodePath<t.VariableDeclarator>) {
        const id = path.node.id;
        if (t.isIdentifier(id) && TRACKED_VARIABLES.has(id.name)) {
          const assignment = t.assignmentExpression(
            '=',
            t.memberExpression(t.identifier('globalThis'), t.identifier(id.name)),
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
            '=',
            t.memberExpression(t.identifier('globalThis'), t.identifier(left.name)),
            t.identifier(left.name)
          );
          const expressionStatement = t.expressionStatement(globalAssignment);
          
          const parent = path.getStatementParent();
          if (parent) {
            parent.insertAfter(expressionStatement);
          }
        }
      }
    });

    return generateDefault(ast).code;
  } catch (error) {
    console.error('AST parsing/rewriting failed:', error);
    return code;
  }
}

class PlaywrightMCPServer {
  private server: Server;
  private context!: vm.Context;
  private isInitialized = false;
  private sessionManager: SingleBrowserSessionManager;

  constructor() {
    this.sessionManager = SingleBrowserSessionManager.getInstance();
    this.server = new Server(
      {
        name: 'playwrightess-mcp',
        version: '1.0.0',
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
    
    const contextObject = {
      // Node.js built-ins
      console,
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
      state: {},
      
      // Other commonly used modules
      assert,
    };

    this.context = vm.createContext(contextObject);
    this.isInitialized = true;

    vm.runInContext("const global = globalThis; const self = globalThis;", this.context);
  }

  private async ensurePlaywrightInitialized() {
    // Check if Playwright instances are already available in the context
    const browser = vm.runInContext("typeof browser !== 'undefined' ? browser : null", this.context);
    const context = vm.runInContext("typeof context !== 'undefined' ? context : null", this.context);
    const page = vm.runInContext("typeof page !== 'undefined' ? page : null", this.context);

    if (!browser || !context || !page) {
      // Initialize session manager instances
      const browserInstance = await this.sessionManager.ensureBrowser();
      const contextInstance = await this.sessionManager.ensureContext();
      const pageInstance = await this.sessionManager.ensurePage();
      
      // Add them to the VM context
      this.context.browser = browserInstance;
      this.context.context = contextInstance;
      this.context.page = pageInstance;
      
      vm.runInContext(`
        globalThis.browser = browser;
        globalThis.context = context;
        globalThis.page = page;
      `, this.context);
    }
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'playwright_eval',
            description: `
              Evaluate JavaScript code in a persistent Playwright context.
              Variables like browser, context, and page are maintained between evaluations.
              Supports top-level await
            `,
            inputSchema: {
              type: 'object',
              properties: {
                code: {
                  type: 'string',
                  description: 'JavaScript code to evaluate in the Playwright context'
                }
              },
              required: ['code']
            }
          }
        ]
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name !== 'playwright_eval') {
        throw new Error(`Unknown tool: ${request.params.name}`);
      }

      const { code } = request.params.arguments as { code: string };

      if (!this.isInitialized) {
        throw new Error('Server not properly initialized');
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

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                result: finalResult !== undefined ? finalResult : 'undefined',
                type: typeof finalResult
              }, null, 2)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined
              }, null, 2)
            }
          ]
        };
      }
    });
  }

  async run() {
    await this.initialize();
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Playwrightess MCP server running on stdio');
  }
}

const server = new PlaywrightMCPServer();

process.on('SIGINT', async () => {
  console.error('Gracefully shutting down...');
  const sessionManager = SingleBrowserSessionManager.getInstance();
  await sessionManager.saveStorageState();
  await sessionManager.cleanup();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.error('Gracefully shutting down...');
  const sessionManager = SingleBrowserSessionManager.getInstance();
  await sessionManager.saveStorageState();
  await sessionManager.cleanup();
  process.exit(0);
});

server.run().catch(console.error);