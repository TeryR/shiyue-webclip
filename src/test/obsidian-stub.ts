/** 测试环境下的 obsidian 桩：所有模块只允许 import，不允许调用 */
export function requestUrl(): never {
  throw new Error("obsidian.requestUrl 不应在测试中被调用");
}

export class Notice {
  constructor(public message?: string, public duration?: number) {}
  setMessage(msg: string): this {
    this.message = msg;
    return this;
  }
  hide(): void {}
}

export class Modal {
  app: unknown;
  contentEl: { empty(): void; createEl: never } = null as never;
  modalEl: { addClass: never } = null as never;
  constructor(app?: unknown) {
    this.app = app;
  }
  open(): void {}
  close(): void {}
}

export class Plugin {
  constructor(public app?: unknown, public manifest?: unknown) {}
  addRibbonIcon(): void {}
  addCommand(): void {}
  addSettingTab(): void {}
  loadData(): unknown {
    return null;
  }
  saveData(): unknown {
    return null;
  }
}

export class PluginSettingTab {
  constructor(public app?: unknown, public plugin?: unknown) {}
  display(): void {}
}

export class Setting {
  constructor(public containerEl?: unknown) {}
  setName(): this {
    return this;
  }
  setDesc(): this {
    return this;
  }
  addText(): this {
    return this;
  }
  addTextArea(): this {
    return this;
  }
  addToggle(): this {
    return this;
  }
  addDropdown(): this {
    return this;
  }
  addExtraButton(): this {
    return this;
  }
}

export class ButtonComponent {
  setButtonText(): this {
    return this;
  }
  setCta(): this {
    return this;
  }
  onClick(): this {
    return this;
  }
}

export function normalizePath(p: string): string {
  return p;
}

export const Platform = { isMobile: false };
export const TFile = class TFile {};
