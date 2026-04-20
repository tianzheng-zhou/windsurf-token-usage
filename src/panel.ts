import * as vscode from "vscode";
import * as crypto from "crypto";
import { getPanelHtml, getLoadingHtml } from "./webview";
import type { DashboardData } from "./types";
import type { DailyDelta } from "./history";

/**
 * Commands the webview is allowed to trigger via postMessage. Kept as an
 * explicit allowlist so a compromised webview can't invoke arbitrary
 * VS Code commands through this bridge.
 */
const PANEL_COMMANDS: ReadonlySet<string> = new Set([
  "windsurf-token-usage.refresh",
  "windsurf-token-usage.refreshFull",
  "windsurf-token-usage.clearHistory",
]);

function generateNonce(): string {
  // 128-bit nonce, base64url — plenty for CSP and no padding issues.
  return crypto.randomBytes(16).toString("base64").replace(/[+/=]/g, "");
}

/**
 * Detail panel opens in the editor area (ViewColumn) so the dashboard has
 * room to breathe. As of 0.3, it runs its own scripts-enabled UI with a
 * strict per-render CSP nonce; the webview posts command messages back to
 * the host for refresh / full-refresh / clear-history.
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

    // Route allowlisted webview-initiated commands back to the extension
    // host. Anything unrecognised is dropped silently — the webview cannot
    // reach into VS Code APIs beyond what we opt it into here.
    this._panel.webview.onDidReceiveMessage((msg: any) => {
      if (!msg || typeof msg.cmd !== "string") {
        return;
      }
      if (!PANEL_COMMANDS.has(msg.cmd)) {
        return;
      }
      void vscode.commands.executeCommand(msg.cmd);
    });

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
        // Scripts are required for the interactive filters / sortable
        // table / row expansion. CSP is enforced inline by getPanelHtml
        // with a per-render nonce.
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [],
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
    if (this._data) {
      // Regenerate the nonce on every render so a stale script tag from a
      // previous paint can't reuse the new content's permissions.
      const nonce = generateNonce();
      this._panel.webview.html = getPanelHtml(this._data, this._deltas, {
        nonce,
        cspSource: this._panel.webview.cspSource,
      });
    } else {
      this._panel.webview.html = getLoadingHtml(this._deltas);
    }
  }
}
