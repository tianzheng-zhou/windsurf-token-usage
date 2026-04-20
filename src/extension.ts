import * as vscode from "vscode";
import { fetchDashboardData, clearCredentials } from "./api";
import { TokenUsageViewProvider } from "./webview";
import {
  loadHistory,
  recordSnapshot,
  clearHistory,
  computeDeltas,
} from "./history";
import type { DashboardData } from "./types";

let statusBarItem: vscode.StatusBarItem;
let lastData: DashboardData | null = null;
let viewProvider: TokenUsageViewProvider;
let refreshTimer: NodeJS.Timeout | undefined;
let startupTimer: NodeJS.Timeout | undefined;
let extContext: vscode.ExtensionContext;

const MIN_REFRESH_SECONDS = 30;
const DEFAULT_REFRESH_SECONDS = 300;

function fmtK(n: number): string {
  if (n >= 1_000_000) {
    return (n / 1_000_000).toFixed(1) + "M";
  }
  if (n >= 1_000) {
    return (n / 1_000).toFixed(1) + "K";
  }
  return n.toString();
}

function getRefreshIntervalMs(): number {
  const cfg = vscode.workspace.getConfiguration("windsurfTokenUsage");
  const sec = cfg.get<number>("refreshIntervalSeconds", DEFAULT_REFRESH_SECONDS);
  if (!Number.isFinite(sec) || sec <= 0) {
    return 0;
  }
  return Math.max(MIN_REFRESH_SECONDS, Math.floor(sec)) * 1000;
}

function pushViewUpdate(): void {
  const store = loadHistory(extContext);
  viewProvider.update(lastData, computeDeltas(store));
}

async function refreshData(showProgress = false): Promise<void> {
  const doRefresh = async () => {
    try {
      statusBarItem.text = "$(loading~spin) Fetching tokens...";
      lastData = await fetchDashboardData();
      const t = lastData.grandTotal;
      statusBarItem.text = `$(dashboard) ${fmtK(t.total)} tokens`;
      const cost = lastData.estimatedCost.totalCost;
      const costStr = cost < 0.005 ? "<$0.01" : "$" + cost.toFixed(2);
      statusBarItem.tooltip = `Windsurf Token Usage\nInput: ${fmtK(t.inputTokens)} · Output: ${fmtK(t.outputTokens)} · Cached: ${fmtK(t.cachedTokens)}\nEst. API Cost: ${costStr}\n${lastData.conversations.length} conversations\nClick to open dashboard`;

      // Persist today's cumulative snapshot; derive per-day deltas for the view.
      try {
        await recordSnapshot(extContext, lastData);
      } catch {
        /* persistence must never fail the refresh */
      }

      pushViewUpdate();
    } catch (e: any) {
      statusBarItem.text = "$(warning) Tokens: N/A";
      statusBarItem.tooltip = `Windsurf Token Usage\nError: ${e.message}`;
      if (showProgress) {
        vscode.window.showErrorMessage(
          `Windsurf Token Usage: ${e.message}`
        );
      }
    }
  };

  if (showProgress) {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Fetching Windsurf token data...",
        cancellable: false,
      },
      doRefresh
    );
  } else {
    await doRefresh();
  }
}

function scheduleAutoRefresh(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }
  const ms = getRefreshIntervalMs();
  if (ms > 0) {
    refreshTimer = setInterval(() => {
      void refreshData(false);
    }, ms);
  }
}

export function activate(context: vscode.ExtensionContext) {
  // Only activate in Windsurf
  if (!vscode.env.appName?.toLowerCase().includes("windsurf")) {
    return;
  }
  extContext = context;

  // Sidebar view provider
  viewProvider = new TokenUsageViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      TokenUsageViewProvider.viewType,
      viewProvider
    )
  );

  // Seed view with persisted deltas before the first fetch completes.
  pushViewUpdate();

  // Status bar item
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    50
  );
  statusBarItem.command = "windsurf-token-usage.show";
  statusBarItem.text = "$(dashboard) Tokens: ...";
  statusBarItem.tooltip = "Windsurf Token Usage — Click to open dashboard";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand("windsurf-token-usage.show", async () => {
      if (!lastData) {
        await refreshData(true);
      } else {
        pushViewUpdate();
      }
      viewProvider.reveal();
    }),
    vscode.commands.registerCommand(
      "windsurf-token-usage.refresh",
      async () => {
        clearCredentials();
        await refreshData(true);
        viewProvider.reveal();
      }
    ),
    vscode.commands.registerCommand(
      "windsurf-token-usage.clearHistory",
      async () => {
        const pick = await vscode.window.showWarningMessage(
          "Clear all persisted Windsurf token usage history? This cannot be undone.",
          { modal: true },
          "Clear"
        );
        if (pick === "Clear") {
          await clearHistory(context);
          pushViewUpdate();
          vscode.window.showInformationMessage(
            "Windsurf token usage history cleared."
          );
        }
      }
    ),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("windsurfTokenUsage.refreshIntervalSeconds")) {
        scheduleAutoRefresh();
      }
    })
  );

  // Initial fetch after a short delay (give the LS time to start), then tick.
  startupTimer = setTimeout(() => {
    void refreshData(false);
    scheduleAutoRefresh();
  }, 8000);

  context.subscriptions.push({
    dispose() {
      if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = undefined;
      }
      if (startupTimer) {
        clearTimeout(startupTimer);
        startupTimer = undefined;
      }
    },
  });
}

export function deactivate() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = undefined;
  }
}
