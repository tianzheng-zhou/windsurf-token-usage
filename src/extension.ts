import * as vscode from "vscode";
import {
  fetchDashboardData,
  clearCredentials,
  clearConversationCache,
} from "./api";
import { TokenUsageViewProvider } from "./webview";
import { TokenUsageDetailPanel } from "./panel";
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
let inflightRefresh: Promise<void> | null = null;

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

function fmtCost(n: number): string {
  if (n < 0.005) {
    return "<$0.01";
  }
  return "$" + n.toFixed(2);
}

function localDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Sum the trailing `n` days of per-day buckets (inclusive of today). We walk
 * the calendar rather than the last-N array entries so sparse days (no
 * activity) don't push the window out past `n` real days.
 */
function sumLastNDays(
  data: DashboardData,
  n: number
): { tokens: number; cost: number; input: number; output: number; cached: number } {
  const out = { tokens: 0, cost: 0, input: 0, output: 0, cached: 0 };
  if (!data.byDay || data.byDay.length === 0 || n <= 0) {
    return out;
  }
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - (n - 1));
  const cutoffStr = localDateString(cutoff);
  for (const d of data.byDay) {
    if (d.date >= cutoffStr) {
      out.tokens += d.tokens;
      out.cost += d.cost;
      out.input += d.input;
      out.output += d.output;
      out.cached += d.cached;
    }
  }
  return out;
}

function getTodayTotals(data: DashboardData): {
  tokens: number;
  cost: number;
  input: number;
  output: number;
  cached: number;
} {
  const todayStr = localDateString(new Date());
  const d = data.byDay.find((x) => x.date === todayStr);
  if (!d) {
    return { tokens: 0, cost: 0, input: 0, output: 0, cached: 0 };
  }
  return {
    tokens: d.tokens,
    cost: d.cost,
    input: d.input,
    output: d.output,
    cached: d.cached,
  };
}

function getRefreshIntervalMs(): number {
  const cfg = vscode.workspace.getConfiguration("windsurfTokenUsage");
  const sec = cfg.get<number>("refreshIntervalSeconds", DEFAULT_REFRESH_SECONDS);
  if (!Number.isFinite(sec) || sec <= 0) {
    return 0;
  }
  return Math.max(MIN_REFRESH_SECONDS, Math.floor(sec)) * 1000;
}

/**
 * Prefer the live per-day breakdown derived from turn timestamps — it lets
 * the UI show a correct "Today" figure from the very first refresh. Fall
 * back to day-over-day cumulative deltas only if no live data is available
 * (e.g. before any fetch has completed).
 */
function currentDeltas() {
  if (lastData && lastData.byDay && lastData.byDay.length > 0) {
    return lastData.byDay.map((d) => ({
      date: d.date,
      tokens: d.tokens,
      cost: d.cost,
      cumulativeTokens: 0,
      cumulativeCost: 0,
    }));
  }
  return computeDeltas(loadHistory(extContext));
}

function pushViewUpdate(): void {
  const deltas = currentDeltas();
  viewProvider.update(lastData, deltas);
  // Keep the detail panel in sync with every refresh, if it's open.
  TokenUsageDetailPanel.updateIfOpen(lastData, deltas);
}

/**
 * Core fetch + persist + push-to-view pipeline. Throws on failure so the outer
 * wrapper can decide whether to surface an error notification.
 */
async function doCoreRefresh(opts: { force?: boolean }): Promise<void> {
  statusBarItem.text = "$(loading~spin) Fetching tokens...";
  try {
    lastData = await fetchDashboardData({ force: opts.force });
  } catch (e: any) {
    statusBarItem.text = "$(warning) Tokens: N/A";
    statusBarItem.tooltip = `Windsurf Token Usage\nError: ${e.message}`;
    throw e;
  }

  const t = lastData.grandTotal;
  const today = getTodayTotals(lastData);
  const last30 = sumLastNDays(lastData, 30);
  statusBarItem.text = `$(dashboard) Today ${fmtK(today.tokens)} · 30d ${fmtK(last30.tokens)}`;
  const failedLine =
    lastData.failedConversations > 0
      ? `\n⚠ ${lastData.failedConversations} conversation(s) failed to load`
      : "";
  statusBarItem.tooltip =
    `Windsurf Token Usage` +
    `\nToday: ${fmtK(today.tokens)} tokens · ${fmtCost(today.cost)}` +
    `\nLast 30 days: ${fmtK(last30.tokens)} tokens · ${fmtCost(last30.cost)}` +
    `\nAll time: ${fmtK(t.total)} tokens · ${fmtCost(lastData.estimatedCost.totalCost)}` +
    `\nInput ${fmtK(t.inputTokens)} · Output ${fmtK(t.outputTokens)} · Cached ${fmtK(t.cachedTokens)}` +
    `\n${lastData.conversations.length} conversations${failedLine}` +
    `\nClick to open dashboard`;

  // Persist today's cumulative snapshot; derive per-day deltas for the view.
  try {
    await recordSnapshot(extContext, lastData);
  } catch {
    /* persistence must never fail the refresh */
  }

  pushViewUpdate();
}

/**
 * Refresh entry point. Reuses any in-flight refresh to avoid duplicate fetches
 * triggered by auto-refresh + manual click racing. `opts.force` bypasses the
 * per-cascade cache.
 *
 * NOTE: if an incremental refresh is already running and the caller requests
 * force=true, it will still join the incremental refresh for this cycle. This
 * is an intentional trade-off for simplicity: spam-clicking Full twice works.
 */
async function refreshData(
  showProgress = false,
  opts: { force?: boolean } = {}
): Promise<void> {
  const runOrJoin = (): Promise<void> => {
    if (inflightRefresh) {
      return inflightRefresh;
    }
    const p = doCoreRefresh(opts);
    inflightRefresh = p;
    p.finally(() => {
      if (inflightRefresh === p) {
        inflightRefresh = null;
      }
    }).catch(() => {
      /* awaiters handle rejection via the returned promise */
    });
    return p;
  };

  try {
    if (showProgress) {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: opts.force
            ? "Refreshing Windsurf token data (full)..."
            : "Refreshing Windsurf token data...",
          cancellable: false,
        },
        () => runOrJoin()
      );
    } else {
      await runOrJoin();
    }
  } catch (e: any) {
    if (showProgress) {
      vscode.window.showErrorMessage(
        `Windsurf Token Usage: ${e.message}`
      );
    }
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
        // Incremental: reuse per-cascade cache + existing credentials.
        await refreshData(true, { force: false });
        viewProvider.reveal();
      }
    ),
    vscode.commands.registerCommand(
      "windsurf-token-usage.refreshFull",
      async () => {
        // Full: re-extract CSRF and re-fetch every trajectory's steps.
        clearCredentials();
        clearConversationCache();
        await refreshData(true, { force: true });
        viewProvider.reveal();
      }
    ),
    vscode.commands.registerCommand(
      "windsurf-token-usage.openPanel",
      async () => {
        // Lazy-fetch on first open if we have nothing cached yet.
        if (!lastData) {
          await refreshData(true);
        }
        TokenUsageDetailPanel.show(lastData, currentDeltas());
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
