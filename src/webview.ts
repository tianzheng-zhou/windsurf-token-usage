import * as vscode from "vscode";
import type { DashboardData } from "./types";
import type { DailyDelta } from "./history";
import type { QuotaInfo } from "./quota";

export class TokenUsageViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "windsurf-token-usage.dashboard";

  private _view?: vscode.WebviewView;
  private _data: DashboardData | null = null;
  private _deltas: DailyDelta[] = [];

  constructor(private readonly _extensionContext: vscode.ExtensionContext) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: false,
      // Allow clickable command:-URI anchors for our own commands (e.g. the
      // "Open Details →" link below). No scripts are still enabled on the
      // sidebar — the interactive surface lives in the detail panel only.
      enableCommandUris: [
        "windsurf-token-usage.openPanel",
        "windsurf-token-usage.refresh",
        "windsurf-token-usage.refreshFull",
        "windsurf-token-usage.clearHistory",
      ],
    } as any;
    this._render();
  }

  public update(data: DashboardData | null, deltas: DailyDelta[] = []): void {
    if (data) {
      this._data = data;
    }
    this._deltas = deltas;
    this._render();
  }

  public reveal(): void {
    if (this._view) {
      this._view.show?.(true);
    }
  }

  private _render(): void {
    if (!this._view) {
      return;
    }
    this._view.webview.html = this._data
      ? getSidebarHtml(this._data, this._deltas)
      : getLoadingHtml(this._deltas);
  }
}

export function getLoadingHtml(deltas: DailyDelta[] = []): string {
  const trend = buildTrendSection(deltas);
  const body = trend
    ? `<h1>⚡ Token Usage</h1><div class="subtitle">Fetching current data…</div>${trend}`
    : `<div class="center"><p>Loading token data…</p></div>`;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/>
<style>${baseStyles()}</style>
</head><body>${body}</body></html>`;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

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

function fmtTime(iso: string): string {
  if (!iso) {
    return "";
  }
  const d = new Date(iso);
  // `undefined` locale → use the user's system default (respects VS Code's
  // configured UI language via the ICU layer). Replaces the hardcoded
  // "zh-CN" that 0.2.x used.
  return d.toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Compact sidebar view: a single 2-row × 5-column KPI table showing Today
 * and Total input/output/cached/total + cost. No trend, no conversation
 * list — those live in the interactive detail panel.
 */
export function getSidebarHtml(data: DashboardData, _deltas: DailyDelta[] = []): string {
  const { conversations, grandTotal, estimatedCost, fetchedAt, failedConversations, fullRefresh } = data;
  const todayStr = todayLocalDateString();
  const today =
    data.byDay.find((d) => d.date === todayStr) ??
    { input: 0, output: 0, cached: 0, tokens: 0, cost: 0 };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Windsurf Token Usage</title>
<style>${baseStyles()}</style>
</head>
<body>
  <h1>⚡ Token Usage</h1>
  <div class="subtitle">
    <span class="subtitle-info">${conversations.length} conversations${failedConversations > 0 ? ` · <span class="failed">${failedConversations} failed</span>` : ""} · ${fmtTime(fetchedAt)}${fullRefresh ? ` · <span class="badge-full">full</span>` : ""}</span>
    <a class="open-details" href="command:windsurf-token-usage.openPanel" title="Open the full dashboard in the editor area">Open Details →</a>
  </div>

  <table class="kpi">
    <thead>
      <tr><th></th><th>In</th><th>Out</th><th>Cached</th><th>Total</th><th>Cost</th></tr>
    </thead>
    <tbody>
      <tr class="kpi-today">
        <th scope="row">Today</th>
        <td>${fmtK(today.input)}</td>
        <td>${fmtK(today.output)}</td>
        <td>${fmtK(today.cached)}</td>
        <td class="kpi-total">${fmtK(today.tokens)}</td>
        <td class="kpi-cost">${fmtCost(today.cost)}</td>
      </tr>
      <tr class="kpi-grand">
        <th scope="row">Total</th>
        <td>${fmtK(grandTotal.inputTokens)}</td>
        <td>${fmtK(grandTotal.outputTokens)}</td>
        <td>${fmtK(grandTotal.cachedTokens)}</td>
        <td class="kpi-total">${fmtK(grandTotal.total)}</td>
        <td class="kpi-cost">${fmtCost(estimatedCost.totalCost)}</td>
      </tr>
    </tbody>
  </table>

  ${buildQuotaLine(data.quota ?? null, data.quotaError ?? null)}
</body>
</html>`;
}

/**
 * Compact single-line rendering of the account quota in the sidebar only.
 * Degrades gracefully: missing fields are skipped, a null snapshot falls
 * back to "N/A" rather than blowing up the sidebar.
 *
 * When `quota` is null we surface `errorReason` in the tooltip so users can
 * tell *why* the line is N/A (e.g. "no apiKey found", "HTTP 401") — handy
 * when debugging without opening the Output channel.
 */
function buildQuotaLine(
  quota: QuotaInfo | null,
  errorReason: string | null
): string {
  if (!quota) {
    const baseMsg = "Account quota unavailable.";
    const reason = errorReason
      ? `\nReason: ${errorReason}`
      : "";
    const hint = "\nOpen \"Windsurf Token Usage\" Output channel for details.";
    return `<div class="quota-line" title="${escHtml(baseMsg + reason + hint)}"><span class="quota-label">Quota</span><span class="quota-na">N/A</span>${errorReason ? `<span class="quota-reason">${escHtml(errorReason)}</span>` : ""}</div>`;
  }

  const parts: string[] = [];

  // Daily used %
  if (quota.dailyUsedPct !== undefined) {
    parts.push(
      `<span class="quota-item" title="Daily quota used">Daily <b>${Math.round(quota.dailyUsedPct)}%</b></span>`
    );
  }
  // Weekly used %
  if (quota.weeklyUsedPct !== undefined) {
    parts.push(
      `<span class="quota-item" title="Weekly quota used">Weekly <b>${Math.round(quota.weeklyUsedPct)}%</b></span>`
    );
  }

  if (parts.length === 0) {
    return `<div class="quota-line"><span class="quota-label">Quota</span><span class="quota-na">N/A</span></div>`;
  }

  const tooltip = [
    quota.plan ? `Plan: ${quota.plan}` : null,
    `Source: ${
      quota.source === "local-sqlite"
        ? "state.vscdb apiKey"
        : "devClient reflection"
    }`,
  ]
    .filter(Boolean)
    .join("\n");
  return `<div class="quota-line" title="${escHtml(tooltip)}"><span class="quota-label">Quota</span>${parts.join('<span class="quota-sep">·</span>')}</div>`;
}

/**
 * Format a 0..100 number as a percent string with one decimal when small
 * and integer when close to full, so it stays readable at a glance.
 */
function fmtPct(pct: number): string {
  if (pct >= 10 || pct === 0) {
    return `${Math.round(pct)}%`;
  }
  return `${pct.toFixed(1)}%`;
}

/**
 * Render the quota reset date as compactly as possible. Accepts ISO 8601
 * strings as well as bare YYYY-MM-DD; falls back to the raw string for
 * anything the Date parser rejects.
 */
function fmtQuotaDate(s: string): string {
  if (!s) {
    return "";
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    // Not a parseable date — probably already a short form like "05-01".
    return s;
  }
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${m}-${day}`;
}

/**
 * Options for the interactive detail panel. The caller (panel.ts) supplies
 * the CSP nonce and the webview's CSP source so we can lock down the HTML
 * to only execute our own inline script.
 */
export interface PanelHtmlOptions {
  /** Cryptographic nonce unique to this render (regenerate every update). */
  nonce: string;
  /** `webview.cspSource` \u2014 required by VS Code's CSP for style-src. */
  cspSource: string;
}

/**
 * Interactive detail panel HTML. The server-side renderer emits an empty
 * shell + an inlined JSON data island + one nonce-gated runner script. All
 * filtering, sorting, and row expansion happens client-side in the webview,
 * which lets the user iterate without the extension re-fetching.
 */
export function getPanelHtml(
  data: DashboardData,
  deltas: DailyDelta[],
  opts: PanelHtmlOptions
): string {
  // Serialize into a form safe to embed as <script type="application/json">.
  // Escaping `</` prevents a hostile cascadeId / summary from breaking out
  // of the script tag. (Defense-in-depth; all field values are already
  // sourced from the local LS, not user input.)
  const payload = JSON.stringify({ data, deltas })
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

  const csp = [
    `default-src 'none'`,
    `style-src ${opts.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${opts.nonce}'`,
    `font-src ${opts.cspSource}`,
    `img-src ${opts.cspSource} data:`,
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy" content="${csp}"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Windsurf Token Usage</title>
<style>${baseStyles()}</style>
</head>
<body>
  <h1>\u26a1 Token Usage</h1>
  <div class="subtitle">
    <span id="meta" class="subtitle-info"></span>
    <span class="toolbar">
      <button data-cmd="windsurf-token-usage.refresh" title="Incremental refresh \u2014 reuses per-cascade cache">\u21bb Refresh</button>
      <button data-cmd="windsurf-token-usage.refreshFull" title="Full refresh \u2014 clears caches and re-extracts credentials">\u27f3 Full</button>
      <button data-cmd="windsurf-token-usage.clearHistory" title="Wipe persisted daily snapshots">\u2205 Clear History</button>
    </span>
  </div>

  <div id="failed"></div>

  <div id="kpi"></div>

  <div class="filters">
    <label>Lookback
      <select id="f-lookback">
        <option value="1">Today</option>
        <option value="7">Last 7 days</option>
        <option value="30" selected>Last 30 days</option>
        <option value="90">Last 90 days</option>
        <option value="0">All time</option>
      </select>
    </label>
    <label>Model <select id="f-model"></select></label>
    <label>Workspace <select id="f-workspace"></select></label>
    <span id="f-count" class="f-count"></span>
  </div>

  <div class="section-title">Trend</div>
  <div id="trend"></div>

  <div class="section-title">By model</div>
  <div id="by-model"></div>

  <div class="section-title">By workspace</div>
  <div id="by-workspace"></div>

  <div class="section-title">Conversations <span id="c-count" class="section-sub"></span></div>
  <div id="conversations"></div>

  <script nonce="${opts.nonce}" type="application/json" id="__data__">${payload}</script>
  <script nonce="${opts.nonce}">${panelScript()}</script>
</body>
</html>`;
}

function baseStyles(): string {
  return `
:root {
  --bg: var(--vscode-sideBar-background, var(--vscode-editor-background));
  --surface: var(--vscode-editorWidget-background, var(--vscode-editor-background));
  --border: var(--vscode-widget-border, var(--vscode-editorWidget-border, rgba(128,128,128,0.2)));
  --text: var(--vscode-foreground);
  --text-dim: var(--vscode-descriptionForeground);
  --accent: var(--vscode-textLink-foreground);
  --accent2: var(--vscode-testing-iconPassed, var(--vscode-charts-green, #4ec94e));
  --accent3: var(--vscode-charts-orange, var(--vscode-editorWarning-foreground, #cca700));
  --danger: var(--vscode-errorForeground, var(--vscode-charts-red, #f44));
  --cost-color: var(--vscode-charts-yellow, var(--vscode-editorWarning-foreground, #cca700));
  --font: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
  --font-mono: var(--vscode-editor-font-family, 'JetBrains Mono', 'Fira Code', monospace);
}
* { margin:0; padding:0; box-sizing:border-box; }
body {
  font-family: var(--font);
  background: var(--bg);
  color: var(--text);
  padding: 12px;
  line-height: 1.5;
}
.center {
  display:flex; align-items:center; justify-content:center; min-height: 50vh;
}
.center p { color: var(--text-dim); }
h1 {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 4px;
  color: var(--accent);
}
.subtitle {
  color: var(--text-dim);
  font-size: 11px;
  margin-bottom: 12px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.subtitle-info {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.open-details {
  flex: 0 0 auto;
  color: var(--accent);
  text-decoration: none;
  font-weight: 600;
  white-space: nowrap;
}
.open-details:hover {
  text-decoration: underline;
}
.subtitle .failed {
  color: var(--danger);
  font-weight: 600;
}
.subtitle .badge-full {
  display: inline-block;
  padding: 0 5px;
  border-radius: 3px;
  border: 1px solid var(--border);
  color: var(--text-dim);
  font-size: 9px;
  letter-spacing: 0.3px;
  text-transform: uppercase;
  vertical-align: 1px;
}
.cards {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-bottom: 16px;
}
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
}
.card.wide {
  grid-column: 1 / -1;
}
.card .label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: var(--text-dim);
  margin-bottom: 2px;
}
.card .value {
  font-size: 20px;
  font-weight: 700;
}
.card.input .value { color: var(--accent); }
.card.output .value { color: var(--accent2); }
.card.cached .value { color: var(--accent3); }
.card.total .value { color: var(--danger); }
.card.cost .value { color: var(--cost-color); }
.card .sub { font-size: 10px; color: var(--text-dim); margin-top: 2px; }

.section-title {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  color: var(--text-dim);
  margin-bottom: 8px;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--border);
}

.trend-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 8px;
}
.trend-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 6px;
}
.trend-title {
  font-size: 11px;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.3px;
}
.trend-last {
  font-size: 11px;
  font-weight: 700;
  color: var(--text);
}
.trend-svg {
  width: 100%;
  height: 48px;
  display: block;
}
.trend-svg .bar { fill: var(--accent); opacity: 0.25; }
.trend-svg .bar.cost { fill: var(--cost-color); opacity: 0.25; }
.trend-svg .line {
  fill: none;
  stroke: var(--accent);
  stroke-width: 1.5;
}
.trend-svg .line.cost { stroke: var(--cost-color); }
.trend-range {
  font-size: 9px;
  color: var(--text-dim);
  display: flex;
  justify-content: space-between;
  margin-top: 2px;
}
.trend-empty {
  font-size: 11px;
  color: var(--text-dim);
  text-align: center;
  padding: 8px 0;
}

.conv-item {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 8px;
}
.conv-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
}
.conv-num {
  font-size: 11px;
  font-weight: 700;
  color: var(--text-dim);
}
.conv-cost {
  font-size: 12px;
  font-weight: 700;
  color: var(--cost-color);
}
.conv-summary {
  font-size: 12px;
  font-weight: 500;
  margin-bottom: 4px;
  word-break: break-word;
}
.conv-meta {
  font-size: 10px;
  color: var(--text-dim);
  margin-bottom: 2px;
}
.conv-models {
  font-size: 10px;
  color: var(--text-dim);
  margin-bottom: 6px;
}
.conv-tokens {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 10px;
  font-family: var(--font-mono);
  margin-bottom: 4px;
}
.t-in { color: var(--accent); }
.t-out { color: var(--accent2); }
.t-cache { color: var(--accent3); }
.t-total { color: var(--danger); font-weight: 700; }
.conv-bar-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.bar {
  flex: 0 0 auto;
  height: 4px;
  border-radius: 2px;
  background: var(--accent);
  opacity: 0.6;
}
.bar-label {
  font-size: 9px;
  color: var(--text-dim);
}

/* ── KPI table (sidebar + panel) ──────────────────────────────────────── */
table.kpi {
  width: 100%;
  border-collapse: collapse;
  font-family: var(--font-mono);
  font-size: 11px;
  margin-bottom: 12px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}
table.kpi th, table.kpi td {
  padding: 4px 8px;
  text-align: right;
  white-space: nowrap;
}
table.kpi thead th {
  font-family: var(--font);
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  color: var(--text-dim);
  border-bottom: 1px solid var(--border);
  background: transparent;
}
table.kpi tbody th {
  text-align: left;
  font-family: var(--font);
  font-size: 11px;
  font-weight: 600;
  color: var(--text-dim);
}
table.kpi tbody tr + tr th,
table.kpi tbody tr + tr td {
  border-top: 1px dashed var(--border);
}
table.kpi td { color: var(--text); }
table.kpi td.kpi-total { color: var(--danger); font-weight: 700; }
table.kpi td.kpi-cost { color: var(--cost-color); font-weight: 700; }
table.kpi .kpi-today th { color: var(--accent); }

/* ── Quota line (sidebar only) ────────────────────────────────────────── */
.quota-line {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 5px 8px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text);
}
.quota-line .quota-label {
  color: var(--text-dim);
  font-family: var(--font);
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}
.quota-line .quota-item b {
  color: var(--accent);
  font-weight: 700;
}
.quota-line .quota-reset {
  color: var(--text-dim);
  font-size: 10px;
}
.quota-line .quota-sep {
  color: var(--text-dim);
  opacity: 0.6;
}
.quota-line .quota-na {
  color: var(--text-dim);
  font-style: italic;
}
.quota-line .quota-reason {
  color: var(--danger);
  font-size: 10px;
  margin-left: 4px;
  opacity: 0.85;
}

/* ── Panel toolbar buttons ────────────────────────────────────────────── */
.toolbar {
  display: inline-flex;
  gap: 6px;
  flex: 0 0 auto;
}
.toolbar button {
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 2px 8px;
  font-family: var(--font);
  font-size: 11px;
  cursor: pointer;
}
.toolbar button:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.toolbar button:active {
  opacity: 0.7;
}

/* ── Filter bar ───────────────────────────────────────────────────────── */
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  align-items: center;
  padding: 8px 10px;
  margin-bottom: 12px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 11px;
}
.filters label {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  color: var(--text-dim);
}
.filters select {
  background: var(--vscode-input-background, var(--bg));
  color: var(--vscode-input-foreground, var(--text));
  border: 1px solid var(--vscode-input-border, var(--border));
  border-radius: 3px;
  padding: 2px 6px;
  font-family: var(--font);
  font-size: 11px;
  max-width: 200px;
}
.filters .f-count {
  margin-left: auto;
  color: var(--text-dim);
  font-size: 10px;
  font-family: var(--font-mono);
}

/* ── Failed cascade list ──────────────────────────────────────────────── */
.failed-block {
  background: var(--surface);
  border: 1px solid var(--danger);
  border-left-width: 3px;
  border-radius: 4px;
  padding: 6px 10px;
  margin-bottom: 12px;
  font-size: 11px;
}
.failed-block summary {
  cursor: pointer;
  color: var(--danger);
  font-weight: 600;
  user-select: none;
}
.failed-block ul {
  margin: 6px 0 0 0;
  padding: 0 0 0 16px;
  color: var(--text-dim);
  font-family: var(--font-mono);
  font-size: 10px;
  list-style: disc;
}
.failed-block li { margin-bottom: 2px; word-break: break-all; }

/* ── Horizontal bar chart (byModel / byWorkspace) ─────────────────────── */
.bar-chart {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin-bottom: 12px;
}
.bar-row {
  display: grid;
  grid-template-columns: minmax(90px, 1.3fr) minmax(0, 3fr) 60px 60px;
  gap: 8px;
  align-items: center;
  font-size: 11px;
}
.bar-row .bar-name {
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: var(--font-mono);
}
.bar-row .bar-track {
  height: 8px;
  background: var(--border);
  border-radius: 4px;
  overflow: hidden;
  opacity: 0.6;
}
.bar-row .bar-fill {
  height: 100%;
  background: var(--cost-color);
  border-radius: 4px;
}
.bar-row.workspace .bar-fill { background: var(--accent); }
.bar-row .bar-cost {
  text-align: right;
  color: var(--cost-color);
  font-family: var(--font-mono);
  font-weight: 700;
}
.bar-row .bar-tokens {
  text-align: right;
  color: var(--text-dim);
  font-family: var(--font-mono);
}
.empty-block {
  font-size: 11px;
  color: var(--text-dim);
  text-align: center;
  padding: 10px 0;
}

/* ── Conversations table ──────────────────────────────────────────────── */
.section-sub {
  font-size: 10px;
  font-weight: 400;
  color: var(--text-dim);
  text-transform: none;
  letter-spacing: 0;
  margin-left: 6px;
}
table.conversations {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
  margin-bottom: 12px;
}
table.conversations thead th {
  font-family: var(--font);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  color: var(--text-dim);
  text-align: right;
  padding: 4px 6px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}
table.conversations thead th:first-child,
table.conversations thead th.col-summary,
table.conversations thead th.col-model,
table.conversations thead th.col-workspace {
  text-align: left;
}
table.conversations thead th.sort-asc::after { content: " \u25b2"; font-size: 8px; }
table.conversations thead th.sort-desc::after { content: " \u25bc"; font-size: 8px; }
table.conversations tbody td {
  padding: 4px 6px;
  text-align: right;
  font-family: var(--font-mono);
  border-bottom: 1px dashed var(--border);
  white-space: nowrap;
  vertical-align: top;
}
table.conversations tbody td.col-summary,
table.conversations tbody td.col-model,
table.conversations tbody td.col-workspace {
  text-align: left;
  font-family: var(--font);
}
table.conversations tbody td.col-summary {
  white-space: normal;
  word-break: break-word;
  min-width: 180px;
}
table.conversations tbody td.col-model,
table.conversations tbody td.col-workspace {
  color: var(--text-dim);
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
table.conversations tbody td.col-cost { color: var(--cost-color); font-weight: 700; }
table.conversations tbody td.col-tokens { color: var(--text); }
table.conversations tbody td.col-pct { color: var(--text-dim); }
table.conversations tbody tr.conv-row { cursor: pointer; }
table.conversations tbody tr.conv-row:hover { background: var(--surface); }
table.conversations tbody tr.conv-row.expanded { background: var(--surface); }
table.conversations tbody tr.conv-detail > td {
  padding: 8px 10px;
  font-family: var(--font);
  text-align: left;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}
.detail-grid {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 12px;
  font-size: 11px;
}
.detail-grid .k { color: var(--text-dim); }
.detail-grid .v { font-family: var(--font-mono); word-break: break-all; }
.detail-section { margin-top: 8px; }
.detail-section-title {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  color: var(--text-dim);
  margin-bottom: 4px;
}
.detail-models {
  display: grid;
  grid-template-columns: minmax(120px, 1.5fr) repeat(4, minmax(60px, 1fr));
  gap: 2px 10px;
  font-family: var(--font-mono);
  font-size: 10px;
}
.detail-models .dm-head {
  color: var(--text-dim);
  font-family: var(--font);
  text-transform: uppercase;
  letter-spacing: 0.3px;
  font-size: 9px;
}
.detail-models .dm-name { color: var(--text); }
.detail-models .dm-cost { color: var(--cost-color); text-align: right; }
.detail-models .dm-num { text-align: right; color: var(--text-dim); }
`;
}

function buildTrendSection(deltas: DailyDelta[]): string {
  if (!deltas || deltas.length === 0) {
    return "";
  }

  const tokenChart = buildSparkline(deltas, "tokens");
  const costChart = buildSparkline(deltas, "cost");
  return `
  <div class="section-title">Trend (last ${Math.min(30, deltas.length)} days)</div>
  <div class="trend-card">${tokenChart}</div>
  <div class="trend-card">${costChart}</div>
  `;
}

function todayLocalDateString(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function buildSparkline(
  deltas: DailyDelta[],
  metric: "tokens" | "cost"
): string {
  const recent = deltas.slice(-30);
  const values = recent.map((d) => (metric === "tokens" ? d.tokens : d.cost));
  // Pull today's value by date match — otherwise on a zero-activity day we'd
  // misleadingly label yesterday's bar as "Today".
  const todayStr = todayLocalDateString();
  const todayEntry = recent.find((d) => d.date === todayStr);
  const todayValue = todayEntry
    ? metric === "tokens"
      ? todayEntry.tokens
      : todayEntry.cost
    : 0;
  const labelLast =
    metric === "tokens"
      ? `Today: ${fmtK(todayValue)}`
      : `Today: ${fmtCost(todayValue)}`;
  const title = metric === "tokens" ? "Tokens / day" : "Cost / day";

  const nonZero = values.some((v) => v > 0);
  // Render the chart whenever there is at least one non-zero day — even a
  // single-day bar is informative. Only fall back to the empty message when
  // we have literally no usage on record (all zeros, or no days at all).
  if (recent.length === 0 || !nonZero) {
    return `
      <div class="trend-head">
        <span class="trend-title">${title}</span>
        <span class="trend-last">${labelLast}</span>
      </div>
      <div class="trend-empty">No usage recorded yet. Try a refresh after using Cascade.</div>
    `;
  }

  const w = 240;
  const h = 48;
  const pad = 3;
  const max = Math.max(1e-9, ...values);
  const stepX =
    recent.length > 1 ? (w - pad * 2) / (recent.length - 1) : (w - pad * 2);

  const points = recent
    .map((_d, i) => {
      const x = pad + i * stepX;
      const y = h - pad - (values[i] / max) * (h - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  const bars = recent
    .map((_d, i) => {
      const x = pad + i * stepX - 1;
      const barH = Math.max(0.5, (values[i] / max) * (h - pad * 2));
      const y = h - pad - barH;
      const cls = metric === "cost" ? "bar cost" : "bar";
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(
        1
      )}" width="2" height="${barH.toFixed(1)}" class="${cls}"/>`;
    })
    .join("");

  const lineCls = metric === "cost" ? "line cost" : "line";

  return `
    <div class="trend-head">
      <span class="trend-title">${title}</span>
      <span class="trend-last">${labelLast}</span>
    </div>
    <svg class="trend-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
      ${bars}
      <polyline points="${points}" class="${lineCls}"/>
    </svg>
    <div class="trend-range"><span>${escHtml(recent[0].date)}</span><span>${escHtml(
    recent[recent.length - 1].date
  )}</span></div>
  `;
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shortModel(uid: string): string {
  return uid
    .replace("claude-", "")
    .replace("gpt-", "GPT-")
    .replace(/-/g, " ");
}

/**
 * Inline JS bundle for the interactive detail panel. Pure vanilla, no deps,
 * no template literals / no `${}` interpolation inside the code \u2014 keeps the
 * outer TS template literal clean. Uses string concatenation for HTML
 * generation so the TypeScript host pipeline can\'t accidentally interpolate
 * anything into the runtime script.
 *
 * Contract with getPanelHtml shell:
 *  - Reads `<script type="application/json" id="__data__">` → { data, deltas }.
 *  - Reads/writes elements by id: meta, failed, kpi, trend, by-model,
 *    by-workspace, conversations, c-count, f-count, f-lookback, f-model,
 *    f-workspace.
 *  - Listens for toolbar button clicks → postMessage({cmd}) back to the
 *    extension host (handled in panel.ts).
 *  - Never rewrites the shell itself, only its dynamic containers → the
 *    nonce-gated script tag stays valid across re-renders.
 */
function panelScript(): string {
  return `
(function () {
  'use strict';
  var vscode = acquireVsCodeApi();
  var dataEl = document.getElementById('__data__');
  var DATA = {};
  try { DATA = dataEl ? JSON.parse(dataEl.textContent || '{}') : {}; } catch (e) { DATA = {}; }
  var data = DATA.data || {};
  // deltas is accepted for future use (e.g. cumulative cross-day charts)
  // but the panel's trend now sources from data.byDay, which carries real
  // per-turn bucketing; keep the field so we don't silently drop it.
  var deltas = DATA.deltas || [];

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  }
  function cutoffStr(days) {
    if (!days) { return ''; }
    var d = new Date();
    d.setHours(0,0,0,0);
    d.setDate(d.getDate() - (days - 1));
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  }
  var TODAY = todayStr();

  var state = { lookback: 30, model: 'all', workspace: 'all', sortKey: 'cost', sortDir: 'desc' };
  var expanded = Object.create(null);

  var HTML_ESC = {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'};
  function esc(s) {
    if (s === null || s === undefined) { return ''; }
    return String(s).replace(/[&<>"']/g, function (c) { return HTML_ESC[c]; });
  }
  function fmtK(n) {
    n = Number(n) || 0;
    var an = Math.abs(n);
    if (an >= 1e6) { return (n/1e6).toFixed(1) + 'M'; }
    if (an >= 1e3) { return (n/1e3).toFixed(1) + 'K'; }
    return String(Math.round(n));
  }
  function fmtCost(n) {
    n = Number(n) || 0;
    if (n < 0.005) { return '<$0.01'; }
    return '$' + n.toFixed(2);
  }
  function fmtTime(iso) {
    if (!iso) { return ''; }
    var d = new Date(iso);
    if (isNaN(d.getTime())) { return ''; }
    return d.toLocaleString(undefined, {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
  }
  function shortModel(uid) {
    if (!uid) { return ''; }
    return String(uid).replace('claude-','').replace('gpt-','GPT-').replace(/-/g,' ');
  }

  // ── Populate filter dropdowns from the FULL dataset (not the filtered
  //    view) so switching filters doesn't remove previously-available
  //    options mid-session. ────────────────────────────────────────────
  (function initSelects() {
    var mSel = document.getElementById('f-model');
    var wSel = document.getElementById('f-workspace');
    var models = (data.byModel || []).map(function (m) { return m.model; });
    var spaces = (data.byWorkspace || []).map(function (w) { return w.workspace; });
    var mOpts = ['<option value="all">All models</option>'];
    for (var i = 0; i < models.length; i++) {
      mOpts.push('<option value="' + esc(models[i]) + '">' + esc(shortModel(models[i])) + '</option>');
    }
    mSel.innerHTML = mOpts.join('');
    var wOpts = ['<option value="all">All workspaces</option>'];
    for (var j = 0; j < spaces.length; j++) {
      wOpts.push('<option value="' + esc(spaces[j]) + '">' + esc(spaces[j]) + '</option>');
    }
    wSel.innerHTML = wOpts.join('');
  })();

  function compute() {
    var cutoff = cutoffStr(state.lookback);
    var convsAll = data.conversations || [];
    var convs = [];
    for (var i = 0; i < convsAll.length; i++) {
      var c = convsAll[i];
      if (cutoff) {
        var last = (c.lastModifiedTime || '').slice(0, 10);
        // If we can't place a cascade in a time bucket, drop it from
        // windowed views; it still shows up under "All time".
        if (!last || last < cutoff) { continue; }
      }
      if (state.model !== 'all' && !(c.perModel && c.perModel[state.model])) { continue; }
      if (state.workspace !== 'all' && c.workspaceName !== state.workspace) { continue; }
      convs.push(c);
    }

    var daysAll = data.byDay || [];
    var byDay = [];
    for (var k = 0; k < daysAll.length; k++) {
      if (!cutoff || daysAll[k].date >= cutoff) { byDay.push(daysAll[k]); }
    }
    var windowSum = { input:0, output:0, cached:0, tokens:0, cost:0 };
    for (var a = 0; a < byDay.length; a++) {
      windowSum.input += byDay[a].input || 0;
      windowSum.output += byDay[a].output || 0;
      windowSum.cached += byDay[a].cached || 0;
      windowSum.tokens += byDay[a].tokens || 0;
      windowSum.cost += byDay[a].cost || 0;
    }
    var todayEntry = null;
    for (var b = 0; b < daysAll.length; b++) {
      if (daysAll[b].date === TODAY) { todayEntry = daysAll[b]; break; }
    }
    var today = todayEntry || { input:0, output:0, cached:0, tokens:0, cost:0 };

    var bmMap = Object.create(null);
    for (var ci = 0; ci < convs.length; ci++) {
      var pm = convs[ci].perModel || {};
      var keys = Object.keys(pm);
      for (var ki = 0; ki < keys.length; ki++) {
        var mk = keys[ki];
        var d = pm[mk];
        var e = bmMap[mk] || { input:0, output:0, cached:0, cost:0 };
        e.input += d.input || 0;
        e.output += d.output || 0;
        e.cached += d.cached || 0;
        e.cost += d.cost || 0;
        bmMap[mk] = e;
      }
    }
    var byModel = Object.keys(bmMap).map(function (m) {
      var v = bmMap[m];
      return { model: m, input: v.input, output: v.output, cached: v.cached, tokens: v.input + v.output + v.cached, cost: v.cost };
    }).sort(function (a, b) { return (b.cost - a.cost) || (b.tokens - a.tokens); });

    var bwMap = Object.create(null);
    for (var cj = 0; cj < convs.length; cj++) {
      var ws = convs[cj].workspaceName || '(no workspace)';
      var wv = bwMap[ws] || { tokens: 0, cost: 0 };
      wv.tokens += (convs[cj].usage && convs[cj].usage.total) || 0;
      wv.cost += (convs[cj].estimatedCost && convs[cj].estimatedCost.totalCost) || 0;
      bwMap[ws] = wv;
    }
    var byWorkspace = Object.keys(bwMap).map(function (w) {
      return { workspace: w, tokens: bwMap[w].tokens, cost: bwMap[w].cost };
    }).sort(function (a, b) { return (b.cost - a.cost) || (b.tokens - a.tokens); });

    return { convs: convs, byDay: byDay, windowSum: windowSum, today: today, byModel: byModel, byWorkspace: byWorkspace };
  }

  function windowLabel() {
    if (!state.lookback) { return 'All time'; }
    if (state.lookback === 1) { return 'Today window'; }
    return 'Last ' + state.lookback + 'd';
  }

  function renderMeta() {
    var el = document.getElementById('meta');
    var failedCount = (data.failedDetails || []).length;
    var n = (data.conversations || []).length;
    var parts = [n + ' conversations'];
    if (failedCount > 0) { parts.push('<span class="failed">' + failedCount + ' failed</span>'); }
    parts.push(esc(fmtTime(data.fetchedAt || '')));
    if (data.fullRefresh) { parts.push('<span class="badge-full">full</span>'); }
    el.innerHTML = parts.join(' · ');
  }

  function renderFailed() {
    var el = document.getElementById('failed');
    var fails = data.failedDetails || [];
    if (!fails.length) { el.innerHTML = ''; return; }
    var h = '<details class="failed-block"><summary>\u26a0 ' + fails.length + ' conversation(s) failed to load</summary><ul>';
    for (var i = 0; i < fails.length; i++) {
      h += '<li>' + esc(fails[i].cascadeId) + ' \u2014 ' + esc(fails[i].error) + '</li>';
    }
    h += '</ul></details>';
    el.innerHTML = h;
  }

  function renderKpi(c) {
    var el = document.getElementById('kpi');
    var t = c.today;
    var gt = data.grandTotal || {};
    var gcTotal = (data.estimatedCost && data.estimatedCost.totalCost) || 0;
    var win = state.lookback
      ? c.windowSum
      : { input: gt.inputTokens || 0, output: gt.outputTokens || 0, cached: gt.cachedTokens || 0, tokens: gt.total || 0, cost: gcTotal };
    el.innerHTML =
      '<table class="kpi">' +
      '<thead><tr><th></th><th>In</th><th>Out</th><th>Cached</th><th>Total</th><th>Cost</th></tr></thead>' +
      '<tbody>' +
        '<tr class="kpi-today">' +
          '<th scope="row">Today</th>' +
          '<td>' + fmtK(t.input) + '</td>' +
          '<td>' + fmtK(t.output) + '</td>' +
          '<td>' + fmtK(t.cached) + '</td>' +
          '<td class="kpi-total">' + fmtK(t.tokens) + '</td>' +
          '<td class="kpi-cost">' + fmtCost(t.cost) + '</td>' +
        '</tr>' +
        '<tr class="kpi-grand">' +
          '<th scope="row">' + esc(windowLabel()) + '</th>' +
          '<td>' + fmtK(win.input) + '</td>' +
          '<td>' + fmtK(win.output) + '</td>' +
          '<td>' + fmtK(win.cached) + '</td>' +
          '<td class="kpi-total">' + fmtK(win.tokens) + '</td>' +
          '<td class="kpi-cost">' + fmtCost(win.cost) + '</td>' +
        '</tr>' +
      '</tbody></table>';
  }

  function sparkline(days, metric) {
    if (!days.length) { return ''; }
    var vals = days.map(function (d) { return metric === 'tokens' ? (d.tokens || 0) : (d.cost || 0); });
    var maxV = 1e-9;
    for (var i = 0; i < vals.length; i++) { if (vals[i] > maxV) { maxV = vals[i]; } }
    var w = 500, h = 60, pad = 4;
    var stepX = days.length > 1 ? (w - pad * 2) / (days.length - 1) : 0;
    var bars = '';
    for (var j = 0; j < days.length; j++) {
      var x1 = pad + j * stepX - 1;
      var barH = Math.max(0.5, (vals[j] / maxV) * (h - pad * 2));
      var y1 = h - pad - barH;
      var cls = metric === 'cost' ? 'bar cost' : 'bar';
      bars += '<rect x="' + x1.toFixed(1) + '" y="' + y1.toFixed(1) + '" width="2" height="' + barH.toFixed(1) + '" class="' + cls + '"/>';
    }
    var pts = [];
    for (var p = 0; p < days.length; p++) {
      var px = pad + p * stepX;
      var py = h - pad - (vals[p] / maxV) * (h - pad * 2);
      pts.push(px.toFixed(1) + ',' + py.toFixed(1));
    }
    var todayEntry = null;
    for (var q = 0; q < days.length; q++) { if (days[q].date === TODAY) { todayEntry = days[q]; break; } }
    var todayVal = todayEntry ? (metric === 'tokens' ? (todayEntry.tokens || 0) : (todayEntry.cost || 0)) : 0;
    var lineCls = metric === 'cost' ? 'line cost' : 'line';
    var title = metric === 'tokens' ? 'Tokens / day' : 'Cost / day';
    var lastLabel = metric === 'tokens' ? 'Today: ' + fmtK(todayVal) : 'Today: ' + fmtCost(todayVal);
    return '<div class="trend-head"><span class="trend-title">' + title + '</span><span class="trend-last">' + lastLabel + '</span></div>' +
      '<svg class="trend-svg" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" aria-hidden="true">' +
      bars + '<polyline points="' + pts.join(' ') + '" class="' + lineCls + '"/></svg>' +
      '<div class="trend-range"><span>' + esc(days[0].date) + '</span><span>' + esc(days[days.length - 1].date) + '</span></div>';
  }

  function renderTrend(c) {
    var el = document.getElementById('trend');
    if (!c.byDay.length) {
      el.innerHTML = '<div class="empty-block">No usage recorded in this window.</div>';
      return;
    }
    el.innerHTML = '<div class="trend-card">' + sparkline(c.byDay, 'tokens') + '</div>' +
      '<div class="trend-card">' + sparkline(c.byDay, 'cost') + '</div>';
  }

  function renderBars(targetId, rows, type) {
    var el = document.getElementById(targetId);
    if (!rows.length) { el.innerHTML = '<div class="empty-block">No data in this window.</div>'; return; }
    var maxC = 1e-9;
    for (var i = 0; i < rows.length; i++) { if (rows[i].cost > maxC) { maxC = rows[i].cost; } }
    var parts = ['<div class="bar-chart">'];
    var cls = type === 'workspace' ? 'bar-row workspace' : 'bar-row';
    for (var j = 0; j < rows.length; j++) {
      var r = rows[j];
      var name = type === 'workspace' ? r.workspace : shortModel(r.model);
      var title = type === 'workspace' ? r.workspace : r.model;
      var pct = maxC > 0 ? (r.cost / maxC) * 100 : 0;
      parts.push(
        '<div class="' + cls + '" title="' + esc(title) + '">' +
          '<span class="bar-name">' + esc(name) + '</span>' +
          '<div class="bar-track"><div class="bar-fill" style="width:' + pct.toFixed(1) + '%"></div></div>' +
          '<span class="bar-cost">' + fmtCost(r.cost) + '</span>' +
          '<span class="bar-tokens">' + fmtK(r.tokens) + '</span>' +
        '</div>'
      );
    }
    parts.push('</div>');
    el.innerHTML = parts.join('');
  }

  function sortedConvs(convs) {
    var dir = state.sortDir === 'asc' ? 1 : -1;
    var k = state.sortKey;
    var copy = convs.slice();
    copy.sort(function (a, b) {
      var va, vb;
      switch (k) {
        case 'summary':   va = (a.summary || '').toLowerCase(); vb = (b.summary || '').toLowerCase(); break;
        case 'model':     va = ((a.models && a.models[0]) || '').toLowerCase(); vb = ((b.models && b.models[0]) || '').toLowerCase(); break;
        case 'workspace': va = (a.workspaceName || '').toLowerCase(); vb = (b.workspaceName || '').toLowerCase(); break;
        case 'turns':     va = a.turns || 0; vb = b.turns || 0; break;
        case 'time':      va = a.lastModifiedTime || ''; vb = b.lastModifiedTime || ''; break;
        case 'tokens':    va = (a.usage && a.usage.total) || 0; vb = (b.usage && b.usage.total) || 0; break;
        case 'cost':      va = (a.estimatedCost && a.estimatedCost.totalCost) || 0; vb = (b.estimatedCost && b.estimatedCost.totalCost) || 0; break;
        default: va = 0; vb = 0;
      }
      if (va < vb) { return -1 * dir; }
      if (va > vb) { return 1 * dir; }
      return 0;
    });
    return copy;
  }

  function renderConversations(c) {
    var el = document.getElementById('conversations');
    var cntEl = document.getElementById('c-count');
    var fCntEl = document.getElementById('f-count');
    fCntEl.textContent = c.convs.length + ' / ' + ((data.conversations || []).length) + ' conversations match';
    if (!c.convs.length) {
      el.innerHTML = '<div class="empty-block">No conversations match the current filters.</div>';
      cntEl.textContent = '';
      return;
    }
    var sorted = sortedConvs(c.convs);
    var totalTokens = 0, totalCost = 0;
    for (var ti = 0; ti < sorted.length; ti++) {
      totalTokens += (sorted[ti].usage && sorted[ti].usage.total) || 0;
      totalCost += (sorted[ti].estimatedCost && sorted[ti].estimatedCost.totalCost) || 0;
    }
    cntEl.textContent = '\u2014 ' + fmtK(totalTokens) + ' tokens, ' + fmtCost(totalCost);
    var COLS = [
      { k:'#',        cls:'col-num',       sort:'' },
      { k:'Summary',  cls:'col-summary',   sort:'summary' },
      { k:'Model',    cls:'col-model',     sort:'model' },
      { k:'Workspace',cls:'col-workspace', sort:'workspace' },
      { k:'Turns',    cls:'col-turns',     sort:'turns' },
      { k:'Time',     cls:'col-time',      sort:'time' },
      { k:'Tokens',   cls:'col-tokens',    sort:'tokens' },
      { k:'Cost',     cls:'col-cost',      sort:'cost' },
      { k:'%',        cls:'col-pct',       sort:'tokens' }
    ];
    var h = '<table class="conversations"><thead><tr>';
    for (var hi = 0; hi < COLS.length; hi++) {
      var col = COLS[hi];
      var cls2 = col.cls;
      if (col.sort && col.sort === state.sortKey) {
        cls2 += ' ' + (state.sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
      }
      h += '<th class="' + cls2 + '" data-sort="' + esc(col.sort) + '">' + esc(col.k) + '</th>';
    }
    h += '</tr></thead><tbody>';
    for (var ri = 0; ri < sorted.length; ri++) {
      var x = sorted[ri];
      var tokens = (x.usage && x.usage.total) || 0;
      var cost = (x.estimatedCost && x.estimatedCost.totalCost) || 0;
      var pctStr = totalTokens > 0 ? ((tokens / totalTokens) * 100).toFixed(1) : '0';
      var modelsArr = x.models || [];
      var modelLabel = modelsArr.length
        ? shortModel(modelsArr[0]) + (modelsArr.length > 1 ? ' +' + (modelsArr.length - 1) : '')
        : '';
      var ws = x.workspaceName || '(no workspace)';
      var id = x.cascadeId || '';
      var isOpen = !!expanded[id];
      h += '<tr class="conv-row' + (isOpen ? ' expanded' : '') + '" data-id="' + esc(id) + '">' +
        '<td class="col-num">' + (ri + 1) + '</td>' +
        '<td class="col-summary">' + esc(x.summary || '(untitled)') + '</td>' +
        '<td class="col-model" title="' + esc(modelsArr.join(', ')) + '">' + esc(modelLabel) + '</td>' +
        '<td class="col-workspace" title="' + esc(ws) + '">' + esc(ws) + '</td>' +
        '<td class="col-turns">' + (x.turns || 0) + '</td>' +
        '<td class="col-time">' + esc(fmtTime(x.lastModifiedTime || '')) + '</td>' +
        '<td class="col-tokens">' + fmtK(tokens) + '</td>' +
        '<td class="col-cost">' + fmtCost(cost) + '</td>' +
        '<td class="col-pct">' + pctStr + '%</td>' +
      '</tr>';
      if (isOpen) {
        h += '<tr class="conv-detail"><td colspan="9">' + renderDetail(x) + '</td></tr>';
      }
    }
    h += '</tbody></table>';
    el.innerHTML = h;
  }

  function renderDetail(x) {
    var pm = x.perModel || {};
    var modelKeys = Object.keys(pm);
    var h = '<div class="detail-grid">' +
      '<span class="k">Cascade ID</span><span class="v">' + esc(x.cascadeId || '') + '</span>' +
      '<span class="k">Created</span><span class="v">' + esc(fmtTime(x.createdTime || '')) + '</span>' +
      '<span class="k">Updated</span><span class="v">' + esc(fmtTime(x.lastModifiedTime || '')) + '</span>' +
      '<span class="k">Steps</span><span class="v">' + (x.stepCount || 0) + '</span>';
    if (x.workspaces && x.workspaces.length > 1) {
      h += '<span class="k">Workspaces</span><span class="v">' + esc(x.workspaces.join(', ')) + '</span>';
    }
    h += '</div>';
    if (modelKeys.length) {
      h += '<div class="detail-section"><div class="detail-section-title">Per-model breakdown</div>' +
        '<div class="detail-models">' +
        '<span class="dm-head">Model</span><span class="dm-head dm-num">In</span><span class="dm-head dm-num">Out</span><span class="dm-head dm-num">Cached</span><span class="dm-head dm-num">Cost</span>';
      for (var mi = 0; mi < modelKeys.length; mi++) {
        var mk = modelKeys[mi];
        var d = pm[mk];
        h += '<span class="dm-name" title="' + esc(mk) + '">' + esc(shortModel(mk)) + '</span>' +
          '<span class="dm-num">' + fmtK(d.input || 0) + '</span>' +
          '<span class="dm-num">' + fmtK(d.output || 0) + '</span>' +
          '<span class="dm-num">' + fmtK(d.cached || 0) + '</span>' +
          '<span class="dm-cost">' + fmtCost(d.cost || 0) + '</span>';
      }
      h += '</div></div>';
    }
    return h;
  }

  function render() {
    var c = compute();
    renderMeta();
    renderFailed();
    renderKpi(c);
    renderTrend(c);
    renderBars('by-model', c.byModel, 'model');
    renderBars('by-workspace', c.byWorkspace, 'workspace');
    renderConversations(c);
  }

  // ── Wiring ─────────────────────────────────────────────────────────
  document.getElementById('f-lookback').addEventListener('change', function (e) {
    state.lookback = parseInt(e.target.value, 10) || 0;
    render();
  });
  document.getElementById('f-model').addEventListener('change', function (e) {
    state.model = e.target.value;
    render();
  });
  document.getElementById('f-workspace').addEventListener('change', function (e) {
    state.workspace = e.target.value;
    render();
  });
  var toolbarBtns = document.querySelectorAll('.toolbar button[data-cmd]');
  for (var bi = 0; bi < toolbarBtns.length; bi++) {
    (function (btn) {
      btn.addEventListener('click', function () {
        var cmd = btn.getAttribute('data-cmd');
        if (cmd) { vscode.postMessage({ cmd: cmd }); }
      });
    })(toolbarBtns[bi]);
  }
  // Delegate sort-header + row-expansion clicks on the conversations container.
  document.getElementById('conversations').addEventListener('click', function (e) {
    var th = e.target.closest ? e.target.closest('th[data-sort]') : null;
    if (th && th.closest('table.conversations')) {
      var key = th.getAttribute('data-sort');
      if (!key) { return; }
      if (state.sortKey === key) {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortKey = key;
        state.sortDir = (key === 'summary' || key === 'model' || key === 'workspace') ? 'asc' : 'desc';
      }
      render();
      return;
    }
    var row = e.target.closest ? e.target.closest('tr.conv-row') : null;
    if (row) {
      var id = row.getAttribute('data-id');
      if (!id) { return; }
      if (expanded[id]) { delete expanded[id]; } else { expanded[id] = true; }
      render();
    }
  });

  render();
})();
`;
}
