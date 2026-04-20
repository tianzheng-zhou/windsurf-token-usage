import * as vscode from "vscode";
import type { DashboardData } from "./types";

// ── Types ──────────────────────────────────────────────────────────────────

export interface DailySnapshot {
  /** Local-time YYYY-MM-DD. */
  date: string;
  /** ISO timestamp of the snapshot's source fetch. */
  fetchedAt: string;
  /** Cumulative all-time totals at the time of the snapshot. */
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalCost: number;
  conversationCount: number;
}

export interface HistoryStore {
  version: 1;
  snapshots: DailySnapshot[];
}

export interface DailyDelta {
  date: string;
  /** Token delta vs previous stored day (clamped to 0 to absorb deletions). */
  tokens: number;
  cost: number;
  cumulativeTokens: number;
  cumulativeCost: number;
}

// ── Storage ────────────────────────────────────────────────────────────────

const STORAGE_KEY = "windsurfTokenUsage.history.v1";
const MAX_SNAPSHOTS = 180; // ~6 months of daily snapshots

function localDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function loadHistory(context: vscode.ExtensionContext): HistoryStore {
  const raw = context.globalState.get<HistoryStore>(STORAGE_KEY);
  if (raw && raw.version === 1 && Array.isArray(raw.snapshots)) {
    return { version: 1, snapshots: [...raw.snapshots] };
  }
  return { version: 1, snapshots: [] };
}

/**
 * Record a snapshot for today (local time). If a snapshot for the same day
 * already exists, it is overwritten with the newer cumulative values — this is
 * correct because we store running totals, not per-day increments.
 */
export async function recordSnapshot(
  context: vscode.ExtensionContext,
  data: DashboardData
): Promise<HistoryStore> {
  const store = loadHistory(context);
  const now = new Date(data.fetchedAt);
  const today = localDateString(now);

  const snap: DailySnapshot = {
    date: today,
    fetchedAt: data.fetchedAt,
    totalTokens: data.grandTotal.total,
    inputTokens: data.grandTotal.inputTokens,
    outputTokens: data.grandTotal.outputTokens,
    cachedTokens: data.grandTotal.cachedTokens,
    totalCost: data.estimatedCost.totalCost,
    conversationCount: data.conversations.length,
  };

  const idx = store.snapshots.findIndex((s) => s.date === today);
  if (idx >= 0) {
    store.snapshots[idx] = snap;
  } else {
    store.snapshots.push(snap);
    store.snapshots.sort((a, b) => a.date.localeCompare(b.date));
  }

  while (store.snapshots.length > MAX_SNAPSHOTS) {
    store.snapshots.shift();
  }

  await context.globalState.update(STORAGE_KEY, store);
  return store;
}

export async function clearHistory(
  context: vscode.ExtensionContext
): Promise<void> {
  await context.globalState.update(STORAGE_KEY, undefined);
}

// ── Derived: per-day deltas ────────────────────────────────────────────────

/**
 * Convert cumulative snapshots into per-day deltas. The first stored day has a
 * zero delta (no baseline). Deltas are clamped to >= 0 so that rare events
 * such as conversation deletion don't surface as negative "usage".
 */
export function computeDeltas(store: HistoryStore): DailyDelta[] {
  const out: DailyDelta[] = [];
  for (let i = 0; i < store.snapshots.length; i++) {
    const s = store.snapshots[i];
    const prev = i > 0 ? store.snapshots[i - 1] : null;
    const tokens = prev ? Math.max(0, s.totalTokens - prev.totalTokens) : 0;
    const cost = prev ? Math.max(0, s.totalCost - prev.totalCost) : 0;
    out.push({
      date: s.date,
      tokens,
      cost,
      cumulativeTokens: s.totalTokens,
      cumulativeCost: s.totalCost,
    });
  }
  return out;
}
