import * as vscode from "vscode";
import { fetchDashboardData, getCredentials, clearCredentials } from "./api";
import { showDashboard, updateDashboard } from "./webview";
import type { DashboardData } from "./types";

let statusBarItem: vscode.StatusBarItem;
let lastData: DashboardData | null = null;

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
      statusBarItem.tooltip = `Windsurf Token Usage\nInput: ${fmtK(t.inputTokens)} · Output: ${fmtK(t.outputTokens)} · Cached: ${fmtK(t.cachedTokens)}\n${lastData.conversations.length} conversations\nClick to open dashboard`;
      updateDashboard(lastData);
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
        showDashboard(context, lastData);
      }
    }),
    vscode.commands.registerCommand(
      "windsurf-token-usage.refresh",
      async () => {
        clearCredentials();
        await refreshData(true);
        if (lastData) {
          showDashboard(context, lastData);
        }
      }
    )
  );

  // Auto-fetch after a short delay
  setTimeout(() => refreshData(false), 8000);
}

export function deactivate() {}
