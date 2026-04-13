import * as vscode from "vscode";
import type { DashboardData } from "./types";

let panel: vscode.WebviewPanel | undefined;

export function showDashboard(
  context: vscode.ExtensionContext,
  data: DashboardData
): void {
  if (panel) {
    panel.reveal(vscode.ViewColumn.One);
    panel.webview.html = getHtml(data);
    return;
  }

  panel = vscode.window.createWebviewPanel(
    "windsurfTokenUsage",
    "Windsurf Token Usage",
    vscode.ViewColumn.One,
    { enableScripts: false, retainContextWhenHidden: true }
  );

  panel.webview.html = getHtml(data);
  panel.onDidDispose(() => {
    panel = undefined;
  });
}

export function updateDashboard(data: DashboardData): void {
  if (panel) {
    panel.webview.html = getHtml(data);
  }
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

function getHtml(data: DashboardData): string {
  const { conversations, grandTotal, estimatedCost, fetchedAt } = data;

  const rows = conversations
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
      <tr>
        <td class="num">${i + 1}</td>
        <td class="summary" title="${escHtml(c.cascadeId)}">
          ${escHtml(c.summary)}
          <span class="meta">${c.turns} turns · ${c.stepCount} steps</span>
        </td>
        <td class="model">${c.models.map(m => escHtml(shortModel(m))).join("<br/>")}</td>
        <td class="num">${fmt(c.usage.inputTokens)}</td>
        <td class="num">${fmt(c.usage.outputTokens)}</td>
        <td class="num">${fmt(c.usage.cachedTokens)}</td>
        <td class="num total">${fmtK(c.usage.total)}</td>
        <td class="num cost">${fmtCost(c.estimatedCost.totalCost)}</td>
        <td class="bar-cell">
          <div class="bar" style="width:${barWidth}%"></div>
          <span class="bar-label">${pct}%</span>
        </td>
        <td class="time">${fmtTime(c.lastModifiedTime)}</td>
      </tr>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Windsurf Token Usage</title>
<style>
:root {
  --bg: #1e1e2e;
  --surface: #282840;
  --border: #3b3b5c;
  --text: #cdd6f4;
  --text-dim: #a6adc8;
  --accent: #89b4fa;
  --accent2: #a6e3a1;
  --accent3: #fab387;
  --danger: #f38ba8;
}
* { margin:0; padding:0; box-sizing:border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: var(--bg);
  color: var(--text);
  padding: 24px;
  line-height: 1.5;
}
h1 {
  font-size: 22px;
  font-weight: 600;
  margin-bottom: 8px;
  color: var(--accent);
}
.subtitle {
  color: var(--text-dim);
  font-size: 13px;
  margin-bottom: 24px;
}
.cards {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 16px;
  margin-bottom: 28px;
}
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 16px 20px;
}
.card .label {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-dim);
  margin-bottom: 4px;
}
.card .value {
  font-size: 28px;
  font-weight: 700;
}
.card.input .value { color: var(--accent); }
.card.output .value { color: var(--accent2); }
.card.cached .value { color: var(--accent3); }
.card.total .value { color: var(--danger); }
.card.cost .value { color: #f9e2af; }
.card .sub { font-size: 11px; color: var(--text-dim); margin-top: 4px; }

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
thead th {
  text-align: left;
  padding: 10px 8px;
  border-bottom: 2px solid var(--border);
  color: var(--text-dim);
  font-weight: 600;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  position: sticky;
  top: 0;
  background: var(--bg);
}
thead th.r { text-align: right; }
tbody tr {
  border-bottom: 1px solid var(--border);
  transition: background 0.15s;
}
tbody tr:hover {
  background: var(--surface);
}
td {
  padding: 8px;
  vertical-align: middle;
}
td.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 12px;
}
td.total {
  font-weight: 700;
  color: var(--danger);
}
td.cost {
  font-weight: 600;
  color: #f9e2af;
}
td.summary {
  max-width: 260px;
}
td.summary .meta {
  display: block;
  font-size: 11px;
  color: var(--text-dim);
}
td.model {
  color: var(--text-dim);
  font-size: 11px;
}
td.time {
  color: var(--text-dim);
  font-size: 11px;
  white-space: nowrap;
}
td.bar-cell {
  width: 120px;
  position: relative;
}
.bar {
  height: 6px;
  border-radius: 3px;
  background: var(--accent);
  opacity: 0.6;
}
.bar-label {
  font-size: 10px;
  color: var(--text-dim);
}
</style>
</head>
<body>
  <h1>⚡ Windsurf Token Usage</h1>
  <div class="subtitle">
    ${conversations.length} conversations · Updated ${fmtTime(fetchedAt)} · Cost based on official API pricing
  </div>

  <div class="cards">
    <div class="card input">
      <div class="label">Input Tokens</div>
      <div class="value">${fmtK(grandTotal.inputTokens)}</div>
    </div>
    <div class="card output">
      <div class="label">Output Tokens</div>
      <div class="value">${fmtK(grandTotal.outputTokens)}</div>
    </div>
    <div class="card cached">
      <div class="label">Cached Tokens</div>
      <div class="value">${fmtK(grandTotal.cachedTokens)}</div>
    </div>
    <div class="card total">
      <div class="label">Total</div>
      <div class="value">${fmtK(grandTotal.total)}</div>
    </div>
    <div class="card cost">
      <div class="label">Est. API Cost</div>
      <div class="value">${fmtCost(estimatedCost.totalCost)}</div>
      <div class="sub">In: ${fmtCost(estimatedCost.inputCost)} · Out: ${fmtCost(estimatedCost.outputCost)} · Cache: ${fmtCost(estimatedCost.cachedCost)}</div>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th>#</th>
        <th>Conversation</th>
        <th>Model</th>
        <th class="r">Input</th>
        <th class="r">Output</th>
        <th class="r">Cached</th>
        <th class="r">Total</th>
        <th class="r">Est. Cost</th>
        <th>Share</th>
        <th>Last Active</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>
</body>
</html>`;
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
