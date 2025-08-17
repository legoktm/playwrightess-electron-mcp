import * as playwright from 'playwright';

export class SingleBrowserSessionManager {
  private static instance: SingleBrowserSessionManager;
  private browser: playwright.Browser | null = null;
  private context: playwright.BrowserContext | null = null;
  private page: playwright.Page | null = null;

  private constructor() {}

  static getInstance(): SingleBrowserSessionManager {
    if (!SingleBrowserSessionManager.instance) {
      SingleBrowserSessionManager.instance = new SingleBrowserSessionManager();
    }
    return SingleBrowserSessionManager.instance;
  }

  async ensureBrowser(): Promise<playwright.Browser> {
    if (!this.browser || !this.browser.isConnected()) {
      this.browser = await playwright.chromium.launch({
        headless: false,
        args: ['--disable-web-security', '--disable-features=VizDisplayCompositor']
      });
    }
    return this.browser;
  }

  async ensureContext(): Promise<playwright.BrowserContext> {
    if (!this.context) {
      const browser = await this.ensureBrowser();
      
      const storageStatePath = './shared-storage-state.json';
      let storageState;
      
      try {
        const fs = await import('fs/promises');
        await fs.access(storageStatePath);
        storageState = storageStatePath;
      } catch {
        storageState = undefined;
      }

      this.context = await browser.newContext({
        storageState,
        viewport: { width: 1280, height: 720 },
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      });
    }
    return this.context;
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
      await this.context.storageState({ path: './shared-storage-state.json' });
    }
  }

  async cleanup(): Promise<void> {
    if (this.page && !this.page.isClosed()) {
      await this.page.close();
    }
    if (this.context) {
      await this.context.close();
    }
    if (this.browser && this.browser.isConnected()) {
      await this.browser.close();
    }
    
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