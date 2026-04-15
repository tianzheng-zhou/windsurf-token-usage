import * as vscode from "vscode";
import { fetchDashboardData, getCredentials, clearCredentials } from "./api";
import { TokenUsageViewProvider } from "./webview";
import type { DashboardData } from "./types";

let statusBarItem: vscode.StatusBarItem;
let lastData: DashboardData | null = null;
let viewProvider: TokenUsageViewProvider;

function fmtK(n: number): string {
  if (n >= 1_000_000) {
    return (n / 1_000_000).toFixed(1) + "M";
  }
  if (n >= 1_000) {
    return (n / 1_000).toFixed(1) + "K";
  }
  return n.toString();
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
      viewProvider.update(lastData);
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

export function activate(context: vscode.ExtensionContext) {
  // Only activate in Windsurf
  if (!vscode.env.appName?.toLowerCase().includes("windsurf")) {
    return;
  }

  // Sidebar view provider
  viewProvider = new TokenUsageViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      TokenUsageViewProvider.viewType,
      viewProvider
    )
  );

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
      }
      if (lastData) {
        viewProvider.update(lastData);
      }
      viewProvider.reveal();
    }),
    vscode.commands.registerCommand(
      "windsurf-token-usage.refresh",
      async () => {
        clearCredentials();
        await refreshData(true);
        if (lastData) {
          viewProvider.update(lastData);
        }
        viewProvider.reveal();
      }
    )
  );

  // Auto-fetch after a short delay
  setTimeout(() => refreshData(false), 8000);
}

export function deactivate() {}
