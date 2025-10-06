import * as playwright from "playwright";
import type { ElectronApplication } from "playwright";

export class SingleBrowserSessionManager {
  private static instance: SingleBrowserSessionManager;
  private electronApp: ElectronApplication | null = null;
  private context: playwright.BrowserContext | null = null;
  private page: playwright.Page | null = null;
  public electronPath: string | null = null;
  private electronArgs: string[] = [];

  private constructor() {}

  static getInstance(): SingleBrowserSessionManager {
    if (!SingleBrowserSessionManager.instance) {
      SingleBrowserSessionManager.instance = new SingleBrowserSessionManager();
    }
    return SingleBrowserSessionManager.instance;
  }

  setElectronMode(electronPath: string, args: string[] = []): void {
    this.electronPath = electronPath;
    this.electronArgs = args;
  }

  async ensureElectronApp(): Promise<ElectronApplication> {
    if (!this.electronApp) {
      if (!this.electronPath) {
        throw new Error("Electron path not set. Call setElectronMode() first.");
      }

      const { _electron } = playwright as any;
      const app = await _electron.launch({
        executablePath: this.electronPath,
        args: this.electronArgs,
      });

      this.electronApp = app;

      app.on("close", () => {
        console.error("Electron app closed");
        this.electronApp = null;
        this.context = null;
        this.page = null;
      });
    }
    return this.electronApp!;
  }

  async ensureContext(): Promise<playwright.BrowserContext> {
    if (!this.electronApp) {
      await this.ensureElectronApp();
    }
    this.context = this.electronApp!.context();
    return this.context;
  }

  async ensurePage(): Promise<playwright.Page> {
    if (!this.electronApp) {
      await this.ensureElectronApp();
    }
    if (!this.page || this.page.isClosed()) {
      this.page = await this.electronApp!.firstWindow();
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
      if (this.electronApp) {
        await this.electronApp.close();
      }
    } catch (error) {
      console.error("Error closing Electron app:", error);
    }
    this.electronApp = null;
    this.page = null;
    this.context = null;
  }

  getElectronApp(): ElectronApplication | null {
    return this.electronApp;
  }

  getContext(): playwright.BrowserContext | null {
    return this.context;
  }

  getPage(): playwright.Page | null {
    return this.page;
  }
}
