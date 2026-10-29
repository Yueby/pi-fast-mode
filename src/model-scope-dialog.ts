import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager, KeyId, TUI } from "@earendil-works/pi-tui";

export interface ModelItem {
  id: string;
  name: string;
}

export interface ModelScopeDialogOptions {
  provider: string;
  activeModelId?: string;
  models: ModelItem[];
  initialScope?: Set<string> | null;
}

export type ScopeResult = Set<string> | null | undefined;

export function collectProviderModels(
  ctx: ExtensionContext,
  currentProvider: string,
  existingScope?: Set<string> | null
): ModelItem[] {
  const modelMap = new Map<string, string>();

  // 1. Collect all known models for current provider from registry
  try {
    const all = ctx.modelRegistry?.getAll?.() ?? [];
    for (const m of all) {
      if (m && m.provider === currentProvider && m.id) {
        modelMap.set(m.id, m.name || m.id);
      }
    }
  } catch {
    // Registry read is best-effort
  }

  // 2. Ensure the active model is included even if registry didn't list it
  if (ctx.model && ctx.model.provider === currentProvider && ctx.model.id) {
    if (!modelMap.has(ctx.model.id)) {
      modelMap.set(ctx.model.id, ctx.model.name || ctx.model.id);
    }
  }

  // 3. Ensure any pre-existing selected IDs are included so selection isn't lost
  if (existingScope) {
    for (const id of existingScope) {
      if (id && !modelMap.has(id)) {
        modelMap.set(id, id);
      }
    }
  }

  const items: ModelItem[] = [];
  for (const [id, name] of modelMap.entries()) {
    items.push({ id, name });
  }

  const activeId = ctx.model?.id;
  items.sort((a, b) => {
    if (activeId) {
      if (a.id === activeId) return -1;
      if (b.id === activeId) return 1;
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
  });

  return items;
}

export class ModelScopeComponent {
  private readonly provider: string;
  private readonly activeModelId: string | undefined;
  private readonly models: ModelItem[];
  private readonly totalRows: number;
  private readonly maxVisible: number;
  private readonly truncate: (text: string, maxWidth: number) => string;
  private readonly matchesKey: (data: string, key: KeyId) => boolean;
  private readonly onDone: (result: ScopeResult) => void;
  private readonly tui?: TUI;
  private readonly theme?: Theme;
  private readonly keybindings?: KeybindingsManager;

  private isUnrestricted: boolean;
  private readonly selectedIds: Set<string>;
  private selectedIndex = 0;
  private scrollOffset = 0;

  constructor(
    options: ModelScopeDialogOptions,
    onDone: (result: ScopeResult) => void,
    deps: {
      tui?: TUI;
      theme?: Theme;
      keybindings?: KeybindingsManager;
      truncate: (text: string, maxWidth: number) => string;
      matchesKey: (data: string, key: KeyId) => boolean;
      maxVisible?: number;
    }
  ) {
    this.provider = options.provider;
    this.activeModelId = options.activeModelId;
    this.models = options.models;
    this.totalRows = this.models.length + 1; // row 0: all models (unrestricted)
    this.maxVisible = deps.maxVisible ?? 8;
    this.truncate = deps.truncate;
    this.matchesKey = deps.matchesKey;
    this.onDone = onDone;
    this.tui = deps.tui;
    this.theme = deps.theme;
    this.keybindings = deps.keybindings;

    this.isUnrestricted = options.initialScope === null || options.initialScope === undefined;
    if (this.isUnrestricted) {
      this.selectedIds = new Set(this.models.map((m) => m.id));
    } else {
      this.selectedIds = new Set(options.initialScope);
    }
  }

  invalidate(): void {
    // Stateless per-render layout
  }

  getState() {
    return {
      isUnrestricted: this.isUnrestricted,
      selectedIds: new Set(this.selectedIds),
      selectedIndex: this.selectedIndex,
      scrollOffset: this.scrollOffset,
    };
  }

  handleInput(data: string): void {
    const kb = this.keybindings;
    const key = (name: KeyId) => this.matchesKey(data, name);
    const isUp = kb?.matches(data, "tui.select.up") || key("up") || key("k");
    const isDown = kb?.matches(data, "tui.select.down") || key("down") || key("j");
    const isPageUp = kb?.matches(data, "tui.select.pageUp") || key("pageUp");
    const isPageDown = kb?.matches(data, "tui.select.pageDown") || key("pageDown");
    const isHome = key("home");
    const isEnd = key("end");
    const isConfirm = kb?.matches(data, "tui.select.confirm") || key("enter");
    const isCancel = kb?.matches(data, "tui.select.cancel") || key("escape") || key("ctrl+c") || key("q");
    const isSpace = key("space");

    if (isCancel) {
      this.onDone(undefined);
      return;
    }

    if (isConfirm) {
      if (this.isUnrestricted) {
        this.onDone(null);
      } else {
        this.onDone(new Set(this.selectedIds));
      }
      return;
    }

    if (isUp) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.adjustScroll();
      this.tui?.requestRender();
      return;
    }

    if (isDown) {
      this.selectedIndex = Math.min(this.totalRows - 1, this.selectedIndex + 1);
      this.adjustScroll();
      this.tui?.requestRender();
      return;
    }

    if (isPageUp) {
      this.selectedIndex = Math.max(0, this.selectedIndex - this.maxVisible);
      this.adjustScroll();
      this.tui?.requestRender();
      return;
    }

    if (isPageDown) {
      this.selectedIndex = Math.min(this.totalRows - 1, this.selectedIndex + this.maxVisible);
      this.adjustScroll();
      this.tui?.requestRender();
      return;
    }

    if (isHome) {
      this.selectedIndex = 0;
      this.adjustScroll();
      this.tui?.requestRender();
      return;
    }

    if (isEnd) {
      this.selectedIndex = this.totalRows - 1;
      this.adjustScroll();
      this.tui?.requestRender();
      return;
    }

    if (isSpace) {
      if (this.selectedIndex === 0) {
        if (this.isUnrestricted) {
          this.isUnrestricted = false;
        } else {
          this.isUnrestricted = true;
          for (const m of this.models) {
            this.selectedIds.add(m.id);
          }
        }
      } else {
        const model = this.models[this.selectedIndex - 1];
        if (model) {
          if (this.isUnrestricted) {
            this.isUnrestricted = false;
            this.selectedIds.clear();
            for (const m of this.models) {
              if (m.id !== model.id) this.selectedIds.add(m.id);
            }
          } else {
            if (this.selectedIds.has(model.id)) {
              this.selectedIds.delete(model.id);
            } else {
              this.selectedIds.add(model.id);
            }
          }
        }
      }
      this.tui?.requestRender();
      return;
    }

    if (key("u") || key("shift+u")) {
      this.isUnrestricted = true;
      for (const m of this.models) {
        this.selectedIds.add(m.id);
      }
      this.tui?.requestRender();
      return;
    }

    if (key("a") || key("shift+a")) {
      this.isUnrestricted = false;
      for (const m of this.models) {
        this.selectedIds.add(m.id);
      }
      this.tui?.requestRender();
      return;
    }

    if (key("n") || key("shift+n")) {
      this.isUnrestricted = false;
      this.selectedIds.clear();
      this.tui?.requestRender();
      return;
    }
  }

  private adjustScroll(): void {
    if (this.selectedIndex < this.scrollOffset) {
      this.scrollOffset = this.selectedIndex;
    } else if (this.selectedIndex >= this.scrollOffset + this.maxVisible) {
      this.scrollOffset = this.selectedIndex - this.maxVisible + 1;
    }
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const theme = this.theme;
    const accent = (s: string) => (theme?.fg ? theme.fg("accent", s) : s);
    const success = (s: string) => (theme?.fg ? theme.fg("success", s) : s);
    const warning = (s: string) => (theme?.fg ? theme.fg("warning", s) : s);
    const error = (s: string) => (theme?.fg ? theme.fg("error", s) : s);
    const dim = (s: string) => (theme?.fg ? theme.fg("dim", s) : s);
    const bold = (s: string) => (theme?.bold ? theme.bold(s) : s);

    const lines: string[] = [];

    // Header
    lines.push(accent(bold("⚡ Fast Mode — Model Scope")));
    const activeLabel = this.activeModelId ? bold(this.activeModelId) : dim("none");
    lines.push(dim("Provider: ") + bold(this.provider) + dim("  •  Current Model: ") + activeLabel);

    // Mode status indicator
    if (this.isUnrestricted) {
      lines.push(success("🌐 Mode: Unrestricted (all models in provider eligible for Fast Mode)"));
    } else if (this.selectedIds.size === 0) {
      lines.push(error("🚫 Mode: No models selected (Fast Mode blocked for all models in provider)"));
    } else {
      lines.push(
        warning(`🎯 Mode: Custom Scope (${this.selectedIds.size} of ${this.models.length} models selected)`)
      );
    }

    // Keybindings hint
    lines.push(dim("Space: Toggle  |  a: All  |  n: None  |  u: Reset to All  |  Enter: Save  |  Esc: Cancel"));
    lines.push(dim("─".repeat(Math.max(10, Math.min(width, 70)))));

    // Scroll up indicator
    if (this.scrollOffset > 0) {
      lines.push(dim(`  ▲  ${this.scrollOffset} more above`));
    }

    // List items
    const endIndex = Math.min(this.totalRows, this.scrollOffset + this.maxVisible);
    for (let r = this.scrollOffset; r < endIndex; r++) {
      const isCursor = r === this.selectedIndex;
      const cursorPrefix = isCursor ? accent("❯ ") : "  ";

      if (r === 0) {
        const isChecked = this.isUnrestricted;
        const checkStr = isChecked ? success("[✓]") : dim("[ ]");
        const titleStr = "* All models in provider (Unrestricted)";
        const rowText = `${cursorPrefix}${checkStr} ${isCursor ? bold(titleStr) : titleStr}`;
        lines.push(rowText);
      } else {
        const item = this.models[r - 1];
        const isChecked = this.isUnrestricted || this.selectedIds.has(item.id);
        const checkStr = isChecked ? success("[✓]") : dim("[ ]");
        const isCurrent = item.id === this.activeModelId;
        const currentTag = isCurrent ? accent(" (current 📍)") : "";
        const namePart = item.name && item.name !== item.id ? `${item.name} ` : "";
        const label = `${namePart}(${item.id})${currentTag}`;
        const rowText = `${cursorPrefix}${checkStr} ${isCursor ? bold(label) : label}`;
        lines.push(rowText);
      }
    }

    // Scroll down indicator
    const remainingBelow = this.totalRows - endIndex;
    if (remainingBelow > 0) {
      lines.push(dim(`  ▼  ${remainingBelow} more below`));
    }

    lines.push(dim("─".repeat(Math.max(10, Math.min(width, 70)))));
    lines.push(dim("Only models in scope AND toggled ON via /fast receive priority tier."));

    return lines.map((line) => this.truncate(line, width));
  }
}

export async function openModelScopeDialog(
  ctx: ExtensionContext,
  currentScope?: Set<string> | null
): Promise<ScopeResult> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("/fast models requires interactive TUI mode.", "warning");
    return undefined;
  }

  const currentProvider = ctx.model?.provider;
  if (!currentProvider) {
    ctx.ui.notify("Select a model before configuring model scope.", "warning");
    return undefined;
  }

  const models = collectProviderModels(ctx, currentProvider, currentScope);

  return await ctx.ui.custom<ScopeResult>(async (tui, theme, keybindings, done) => {
    const { truncateToWidth, matchesKey } = await import("@earendil-works/pi-tui");
    const component = new ModelScopeComponent(
      {
        provider: currentProvider,
        activeModelId: ctx.model?.id,
        models,
        initialScope: currentScope,
      },
      (result) => done(result),
      {
        tui,
        theme,
        keybindings,
        truncate: truncateToWidth,
        matchesKey,
      }
    );

    return component;
  });
}
