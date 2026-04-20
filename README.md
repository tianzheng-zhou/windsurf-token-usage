# Windsurf Token Usage

Track and visualize Windsurf Cascade token consumption in real-time, right inside the Windsurf IDE.

## Features

- **Live status bar** — shows the running total of tokens used across all Cascade conversations, click to open the dashboard.
- **Side-bar dashboard** — per-conversation breakdown with input / output / cached tokens, model used, and an estimated API cost.
- **Daily trend charts** — persisted locally, shows Tokens/day and Cost/day as mini SVG sparklines for up to 180 days.
- **Auto refresh** — configurable interval; pauses / resumes on config change without reload.
- **Incremental fetch** — only re-queries Cascades whose `lastModifiedTime` changed since the last refresh; a full refresh is still available on demand.
- **Safe credential extraction** — reads the Cascade CSRF token via reflection first, with a tightly-scoped HTTP probe as fallback (never rewrites global HTTP prototypes outside a validated local-loopback window).

## Requirements

- **Windsurf IDE** (the extension activates only when `vscode.env.appName` contains `windsurf`)
- VS Code engine `^1.85.0`

## Commands

All live under the `Windsurf Token Usage:` category in the command palette.

| Command | What it does |
|---|---|
| `Show Token Usage Dashboard` | Opens the side-bar view and fetches data if none cached yet. |
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
- Time stamps in the dashboard currently render in `zh-CN` locale regardless of VS Code UI language (will be switched to user locale in a future release).

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
