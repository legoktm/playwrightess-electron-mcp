import * as playwright from "playwright";
import * as path from "path";
import { spawn } from "child_process";

export class SingleBrowserSessionManager {
  private static instance: SingleBrowserSessionManager;
  private browser: playwright.Browser | null = null;
  private context: playwright.BrowserContext | null = null;
  private page: playwright.Page | null = null;
  private userDataDir: string;

  private constructor() {
    this.userDataDir = path.join(process.cwd(), ".playwright-session");
  }

  static getInstance(): SingleBrowserSessionManager {
    if (!SingleBrowserSessionManager.instance) {
      SingleBrowserSessionManager.instance = new SingleBrowserSessionManager();
    }
    return SingleBrowserSessionManager.instance;
  }

  private async killExistingChromiumProcesses(): Promise<void> {
    return new Promise((resolve) => {
      const killProcess = spawn("pkill", ["-f", "chromium.*--user-data-dir"]);
      killProcess.on("close", () => resolve());
    });
  }

  async ensureBrowser(): Promise<playwright.Browser> {
    if (!this.browser || !this.browser.isConnected()) {
      await this.killExistingChromiumProcesses();

      // Use launchPersistentContext when using userDataDir
      this.context = await playwright.chromium.launchPersistentContext(
        this.userDataDir,
        {
          headless: false,
          args: [
            "--disable-web-security",
            "--disable-features=VizDisplayCompositor",
            "--no-first-run",
            "--disable-default-apps",
          ],
          viewport: { width: 1280, height: 720 },
          userAgent:
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
      );

      // Get the browser from the persistent context
      this.browser = this.context.browser()!;

      this.browser.on("disconnected", () => {
        console.error("Browser disconnected unexpectedly");
        this.browser = null;
        this.context = null;
        this.page = null;
      });

      this.context.setDefaultNavigationTimeout(8000);
    }
    return this.browser;
  }

  async ensureContext(): Promise<playwright.BrowserContext> {
    if (!this.context) {
      // Context is now created in ensureBrowser() via launchPersistentContext
      await this.ensureBrowser();
    }
    return this.context!;
  }

  async ensurePage(): Promise<playwright.Page> {
    if (!this.page || this.page.isClosed()) {
      const context = await this.ensureContext();
      this.page = await context.newPage();
    }
    return this.page;
  }

  async saveStorageState(): Promise<void> {
    if (this.context) {
      await this.context.storageState({ path: "./shared-storage-state.json" });
    }
  }

  async cleanup(): Promise<void> {
    try {
      if (this.page && !this.page.isClosed()) {
        await this.page.close();
      }
    } catch (error) {
      console.error("Error closing page:", error);
    }

    try {
      if (this.context) {
        await this.context.close();
      }
    } catch (error) {
      console.error("Error closing context:", error);
    }

    try {
      if (this.browser && this.browser.isConnected()) {
        await this.browser.close();
      }
    } catch (error) {
      console.error("Error closing browser:", error);
    }

    await this.killExistingChromiumProcesses();

    this.page = null;
    this.context = null;
    this.browser = null;
  }

  getBrowser(): playwright.Browser | null {
    return this.browser;
  }

  getContext(): playwright.BrowserContext | null {
    return this.context;
  }

  getPage(): playwright.Page | null {
    return this.page;
  }
}
