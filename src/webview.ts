import * as vscode from "vscode";
import type { DashboardData } from "./types";
import type { DailyDelta } from "./history";

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
    webviewView.webview.options = { enableScripts: false };
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
      ? getHtml(this._data, this._deltas)
      : getLoadingHtml(this._deltas);
  }
}

function getLoadingHtml(deltas: DailyDelta[] = []): string {
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
  return d.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getHtml(data: DashboardData, deltas: DailyDelta[] = []): string {
  const { conversations, grandTotal, estimatedCost, fetchedAt } = data;

  const convItems = conversations
    .map((c, i) => {
      const pct =
        grandTotal.total > 0
          ? ((c.usage.total / grandTotal.total) * 100).toFixed(1)
          : "0";
      const barWidth =
        grandTotal.total > 0
          ? Math.max(1, (c.usage.total / grandTotal.total) * 100)
          : 0;
      return `
      <div class="conv-item">
        <div class="conv-header">
          <span class="conv-num">#${i + 1}</span>
          <span class="conv-cost">${fmtCost(c.estimatedCost.totalCost)}</span>
        </div>
        <div class="conv-summary" title="${escHtml(c.cascadeId)}">${escHtml(c.summary)}</div>
        <div class="conv-meta">${c.turns} turns · ${c.stepCount} steps · ${fmtTime(c.lastModifiedTime)}</div>
        <div class="conv-models">${c.models.map(m => escHtml(shortModel(m))).join(", ")}</div>
        <div class="conv-tokens">
          <span class="t-in">In ${fmtK(c.usage.inputTokens)}</span>
          <span class="t-out">Out ${fmtK(c.usage.outputTokens)}</span>
          <span class="t-cache">Cache ${fmtK(c.usage.cachedTokens)}</span>
          <span class="t-total">${fmtK(c.usage.total)}</span>
        </div>
        <div class="conv-bar-row">
          <div class="bar" style="width:${barWidth}%"></div>
          <span class="bar-label">${pct}%</span>
        </div>
      </div>`;
    })
    .join("\n");

  const trend = buildTrendSection(deltas);

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
    ${conversations.length} conversations · ${fmtTime(fetchedAt)}
  </div>

  <div class="cards">
    <div class="card input">
      <div class="label">Input</div>
      <div class="value">${fmtK(grandTotal.inputTokens)}</div>
    </div>
    <div class="card output">
      <div class="label">Output</div>
      <div class="value">${fmtK(grandTotal.outputTokens)}</div>
    </div>
    <div class="card cached">
      <div class="label">Cached</div>
      <div class="value">${fmtK(grandTotal.cachedTokens)}</div>
    </div>
    <div class="card total">
      <div class="label">Total</div>
      <div class="value">${fmtK(grandTotal.total)}</div>
    </div>
    <div class="card cost wide">
      <div class="label">Est. API Cost</div>
      <div class="value">${fmtCost(estimatedCost.totalCost)}</div>
      <div class="sub">In: ${fmtCost(estimatedCost.inputCost)} · Out: ${fmtCost(estimatedCost.outputCost)} · Cache: ${fmtCost(estimatedCost.cachedCost)}</div>
  </div>
  </div>

  ${trend}

  <div class="section-title">Conversations</div>
  ${convItems}
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

function buildSparkline(
  deltas: DailyDelta[],
  metric: "tokens" | "cost"
): string {
  const recent = deltas.slice(-30);
  const values = recent.map((d) => (metric === "tokens" ? d.tokens : d.cost));
  const labelLast =
    metric === "tokens"
      ? `Today: ${fmtK(values[values.length - 1] ?? 0)}`
      : `Today: ${fmtCost(values[values.length - 1] ?? 0)}`;
  const title = metric === "tokens" ? "Tokens / day" : "Cost / day";

  const nonZero = values.some((v) => v > 0);
  if (recent.length < 2 || !nonZero) {
    return `
      <div class="trend-head">
        <span class="trend-title">${title}</span>
        <span class="trend-last">${labelLast}</span>
      </div>
      <div class="trend-empty">Collecting history… come back after another refresh.</div>
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
