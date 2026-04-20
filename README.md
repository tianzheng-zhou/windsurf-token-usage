# Windsurf Token Usage

Track and visualize Windsurf Cascade token consumption in real-time, right inside the Windsurf IDE.

## Features

- **Live status bar** — compact `Today · 30d` tokens at-a-glance; hover for per-category + per-window cost breakdown; click to open the dashboard.
- **Compact sidebar KPI table** — Today and Total rows × In / Out / Cached / Total / Cost columns. All key numbers in one glance.
- **Interactive detail panel** — opens in the editor area with scripts-enabled, strict per-render CSP:
  - **Lookback filter** (Today / 7d / 30d / 90d / All time) affects the KPI "window" row, trend chart, distribution charts, and the conversations table.
  - **Model and Workspace filters** narrow the conversations list and recompute the per-model / per-workspace distribution charts.
  - **Tokens/day + Cost/day trend charts** rebuilt for the chosen window.
  - **Per-model and per-workspace horizontal bar charts**, sorted by cost.
  - **Sortable conversations table**: click any column header to sort asc/desc; click any row to expand a detail panel with cascade ID, created/updated times, and per-model in/out/cached/cost breakdown.
  - **Failed-conversation list**: expandable details for any cascade whose steps failed to load this refresh.
  - **Refresh / Full / Clear History** buttons in the panel, wired via `postMessage` to the host commands.
- **Daily trend charts** — persisted locally up to 180 days; today's bar is sourced from real per-turn timestamps so it's correct on first refresh.
- **Auto refresh** — configurable interval; pauses / resumes on config change without reload.
- **Incremental fetch** — only re-queries Cascades whose `lastModifiedTime` changed since the last refresh; a full refresh is still available on demand.
- **Locale-aware timestamps** — timestamps render using the user's system locale (replaces the previously hardcoded `zh-CN`).
- **Safe credential extraction** — reads the Cascade CSRF token via reflection first, with a tightly-scoped HTTP probe as fallback (never rewrites global HTTP prototypes outside a validated local-loopback window).

## Requirements

- **Windsurf IDE** (the extension activates only when `vscode.env.appName` contains `windsurf`)
- VS Code engine `^1.85.0`

## Commands

All live under the `Windsurf Token Usage:` category in the command palette.

| Command | What it does |
|---|---|
| `Show Token Usage Dashboard` | Opens the side-bar view and fetches data if none cached yet. |
| `Open Details Panel` | Opens the dashboard in the editor area for a full-width view. Sidebar stays in place as an ambient summary. |
| `Refresh Token Data` | **Incremental** refresh — reuses the per-cascade cache and existing CSRF credentials. Use this most of the time. |
| `Refresh Token Data (Full)` | **Full** refresh — clears the CSRF cache *and* the per-cascade cache, then re-fetches every trajectory's steps. Use this if numbers look wrong or after a Windsurf upgrade. |
| `Clear History` | Wipes the persisted daily snapshots used to draw the trend charts. |

## Configuration

| Setting | Default | Description |
|---|---|---|
| `windsurfTokenUsage.refreshIntervalSeconds` | `300` | Auto-refresh interval in seconds. Set to `0` to disable auto-refresh. Values between 1 and 29 are clamped to 30 to avoid hammering the local language server. |

## How it works

1. On startup (8 s after activation), the extension locates the `codeium.windsurf` extension's `devClient` and extracts the local language server's CSRF token + port.
2. It calls the local `GetAllCascadeTrajectories` / `GetCascadeTrajectorySteps` Connect-RPC endpoints to read per-turn token usage dimensions.
3. Usage is aggregated per conversation and per model; costs are estimated from a built-in pricing table (see "Caveats" below).
4. A daily cumulative snapshot is written to `context.globalState`; the dashboard derives per-day deltas from these snapshots.

All data stays on your machine. **Nothing is uploaded anywhere.**

## Caveats

- The cost column is an **estimate** based on public list prices at the time of writing (Apr 2026). Several 2026-vintage models (Opus 4.6+, GPT-5.2+, Gemini 3 variants) use best-effort pricing that may drift; treat the dollar figure as a useful relative signal, not an invoice.
- If Windsurf changes the `devClient` internals or the Connect-RPC response shape, the extension will degrade to "Tokens: N/A" until updated. Try `Refresh Token Data (Full)` first; it clears all caches.
- Time stamps now render in the user's system locale (as of 0.3.0). Earlier 0.2.x releases hardcoded `zh-CN`.

## Development

```bash
npm install
npm run compile         # tsc -p .
npm run watch           # tsc -w -p .
npx @vscode/vsce package   # produce a .vsix
```

Launch the extension development host with `F5` from VS Code / Windsurf.

## Privacy

- The extension talks exclusively to `127.0.0.1:<local-LS-port>`.
- Token usage data, snapshots, and CSRF token are kept in memory or in VS Code's `globalState`.
- No telemetry, no outbound network calls.

## Changelog

### 0.3.0

- **Status bar upgraded** to `Today · 30d` tokens; hover tooltip gains per-window cost totals and a cached breakdown line.
- **Sidebar redesign** — compact 2×5 KPI table (Today / Total × In / Out / Cached / Total / Cost) instead of card clusters.
- **Interactive detail panel** with strict CSP + per-render nonce:
  - Lookback, Model, and Workspace filters.
  - Tokens/day + Cost/day sparklines rebuilt for the chosen window.
  - Per-model and per-workspace horizontal bar charts.
  - Sortable conversations table; row-click expands cascade ID, timestamps, and per-model breakdown.
  - Failed-conversation list with per-cascade error messages.
  - Refresh / Full Refresh / Clear History buttons in the panel toolbar, routed to host commands via postMessage allowlist.
- **Per-conversation data model extended** with `workspaceName`, `workspaces`, and `perModel` (with cost); the refresh aggregates global `byModel` and `byWorkspace` breakdowns. Pre-0.3 cached entries are invalidated on first 0.3 load so those fields become populated.
- **Locale-aware timestamps** — rendering switched from hardcoded `zh-CN` to the user's system default.

### 0.2.4

- **Today** cluster now sits above **Total** in both the sidebar and detail panel — the number you check most often is at the top.

### 0.2.3

- **Sidebar slimmed down** — now shows only two clusters of five numbers: overall **Total** and **Today** (Input / Output / Cached / Total tokens + estimated cost each). No conversation list, no trend chart.
- **Trend charts moved to the Details Panel** along with the full conversation list. The sidebar becomes an ambient summary; the panel is the explore surface.
- Per-day breakdown now carries Input / Output / Cached, not just an aggregate token count.

### 0.2.2

- **Refresh button in the view title bar** — refresh and Open Details now appear as icons at the top of the sidebar view; Full Refresh and Clear History live in the `…` overflow.
- **Real "Today" number** — per-turn timestamps are now bucketed into calendar days, so the Trend chart shows today's actual consumption on the very first refresh instead of requiring an overnight baseline.
- Sparkline renders even with a single non-zero day.

### 0.2.1

- Detail panel opens in the editor area via the new `Open Details Panel` command (also reachable from the `Open Details →` link at the top of the sidebar). Reuses the existing dashboard HTML; a future release will tab-ify it with a sortable conversation table.

### 0.2.0

- Side-effect-free reflection for CSRF extraction (with live-ping validation); HTTP prototype patch now a host-filtered fallback only.
- Auto refresh at a configurable interval.
- Persisted daily snapshots + 30-day trend sparklines for tokens and cost.
- Incremental per-cascade caching keyed on `lastModifiedTime`; new `Refresh Token Data (Full)` command to bypass.
- Failed-conversation count surfaced in status-bar tooltip and dashboard subtitle.
- `Clear History` command.

### 0.1.x

- Initial status bar + dashboard + per-conversation usage/cost.

## License

MIT (see `LICENSE` if present).
