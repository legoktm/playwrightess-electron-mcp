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
import { parse } from '@babel/parser';
import traverse, { NodePath } from '@babel/traverse';
// @ts-ignore
const traverseDefault = traverse.default || traverse;
import * as t from '@babel/types';
import generate from '@babel/generator';
// @ts-ignore
const generateDefault = generate.default || generate;

const TRACKED_VARIABLES = new Set(['page', 'browser', 'context']);

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

  constructor() {
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
    this.initializeContext();
  }

  private initializeContext() {
    // Create a persistent VM context with Playwright and Node.js built-ins
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

      // commons
      browser: undefined,
      context: undefined,
      page: undefined,
      
      // Global state object for user variables
      state: {},
      
      // Other commonly used modules
      assert,
    };

    this.context = vm.createContext(contextObject);
    this.isInitialized = true;

    vm.runInContext("const global = globalThis; const self = globalThis;", this.context);

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
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Playwrightess MCP server running on stdio');
  }
}

const server = new PlaywrightMCPServer();
server.run().catch(console.error);