import * as vscode from "vscode";
import { getPanelHtml, getLoadingHtml } from "./webview";
import type { DashboardData } from "./types";
import type { DailyDelta } from "./history";

/**
 * Detail panel that opens in the editor area (ViewColumn) so the dashboard
 * has room to breathe. For Phase 1 this is a thin wrapper that reuses the
 * exact same HTML renderer the sidebar view uses — same content, more width.
 *
 * A later phase can swap the renderer for an enriched (scripts-enabled,
 * tabbed, sortable) version without touching call sites.
 */
export class TokenUsageDetailPanel {
  public static readonly viewType = "windsurf-token-usage.detail";

  private static current: TokenUsageDetailPanel | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private _data: DashboardData | null;
  private _deltas: DailyDelta[];

  private constructor(
    panel: vscode.WebviewPanel,
    data: DashboardData | null,
    deltas: DailyDelta[]
  ) {
    this._panel = panel;
    this._data = data;
    this._deltas = deltas;
    this._render();

    // When the user closes the panel, drop our reference so the next
    // `show()` creates a fresh one.
    this._panel.onDidDispose(() => {
      if (TokenUsageDetailPanel.current === this) {
        TokenUsageDetailPanel.current = undefined;
      }
    });
  }

  /** Open (or reveal) the detail panel and seed it with the latest data. */
  public static show(
    data: DashboardData | null,
    deltas: DailyDelta[]
  ): void {
    if (TokenUsageDetailPanel.current) {
      TokenUsageDetailPanel.current.update(data, deltas);
      TokenUsageDetailPanel.current._panel.reveal(
        vscode.ViewColumn.Active,
        false
      );
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      TokenUsageDetailPanel.viewType,
      "Windsurf Token Usage",
      vscode.ViewColumn.Active,
      {
        enableScripts: false,
        retainContextWhenHidden: true,
      }
    );
    panel.iconPath = new vscode.ThemeIcon("dashboard") as any;

    TokenUsageDetailPanel.current = new TokenUsageDetailPanel(
      panel,
      data,
      deltas
    );
  }

  /**
   * Push updated data into the live panel, if one is open. No-op otherwise.
   * Called after every successful refresh so the panel stays in sync with
   * the status bar / sidebar.
   */
  public static updateIfOpen(
    data: DashboardData | null,
    deltas: DailyDelta[]
  ): void {
    TokenUsageDetailPanel.current?.update(data, deltas);
  }

  private update(data: DashboardData | null, deltas: DailyDelta[]): void {
    if (data) {
      this._data = data;
    }
    this._deltas = deltas;
    this._render();
  }

  private _render(): void {
    this._panel.webview.html = this._data
      ? getPanelHtml(this._data, this._deltas)
      : getLoadingHtml(this._deltas);
  }
}
