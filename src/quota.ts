import * as os from "os";
import * as vscode from "vscode";
import type { WindsurfCredentials } from "./types";
import { httpPost } from "./api";
import {
  getLocalAuthStatus,
  clearLocalAuthCache,
  type WindsurfLocalAuthStatus,
} from "./windsurfAuth";
import { log } from "./logger";

/**
 * Normalized account-quota snapshot. Any subset of fields may be missing
 * depending on what the upstream response populated.
 *
 * Field mapping follows jlcodes99/cockpit-tools' SeatManagementService
 * handling (`build_payload_from_remote`). The server returns
 * `availablePromptCredits` / `availableFlowCredits` as the **remaining**
 * balance and `usedPromptCredits` / `usedFlowCredits` as consumption; the
 * plan's total quota is therefore `used + remaining` — see
 * `extractFromUserStatusResp()` for the computation.
 */
export interface QuotaInfo {
  /** Prompt credits remaining ("available" in server response). */
  promptRemaining?: number;
  /** Flow credits remaining. */
  flowRemaining?: number;
  /** Daily quota **used** percentage (100 − server's dailyQuotaRemainingPercent). */
  dailyUsedPct?: number;
  /** Weekly quota **used** percentage (100 − server's weeklyQuotaRemainingPercent). */
  weeklyUsedPct?: number;
  /** Daily quota reset — ISO 8601 string derived from dailyQuotaResetAtUnix. */
  dailyResetAt?: string;
  /** Weekly quota reset — ISO 8601 string derived from weeklyQuotaResetAtUnix. */
  weeklyResetAt?: string;
  /** Plan end date — ISO 8601 string. */
  resetDate?: string;
  /** e.g. "pro" / "free" / "ultra" / "Trial" — surfaced in the tooltip. */
  plan?: string;
  /** Which credential source produced this snapshot. */
  source: "local-sqlite" | "devClient-reflection";
  /** Always "GetUserStatus" for now — kept for parity with previous shape. */
  method: string;
}

/**
 * Default upstream per jlcodes99/cockpit-tools' `WINDSURF_DEFAULT_API_SERVER_URL`.
 * The per-account `apiServerUrl` from `state.vscdb` takes precedence when present.
 */
const DEFAULT_API_SERVER_URL = "https://server.codeium.com";

/**
 * Called from `clearConversationCache()` on Full Refresh so the next fetch
 * re-reads the SQLite DB rather than trusting the 60s in-memory cache.
 */
export function clearQuotaMemo(): void {
  clearLocalAuthCache();
}

// ── Request building ──────────────────────────────────────────────────────

function normalizedOs(): string {
  switch (os.platform()) {
    case "darwin":
      return "darwin";
    case "win32":
      return "windows";
    case "linux":
      return "linux";
    default:
      return os.platform();
  }
}

/**
 * Mirror of `build_user_status_metadata()` in cockpit-tools'
 * `windsurf_oauth.rs`. The server validates `ideName` / `ideVersion` /
 * `extensionName` — dropping any of them flips the response to
 * `invalid_argument`.
 *
 * `locale` intentionally follows VS Code's own session locale rather than
 * cockpit-tools' hard-coded `zh-CN` — users run in a mix of languages and
 * the server accepts any BCP-47 tag.
 */
function buildMetadata(apiKey: string): Record<string, unknown> {
  const ts = Date.now().toString();
  // vscode.env.language is always present in a real host, but we fall back
  // to "en-US" to keep the module importable under tests.
  let locale = "en-US";
  try {
    if (vscode.env?.language) {
      locale = vscode.env.language;
    }
  } catch {
    /* best effort */
  }
  return {
    apiKey,
    ideName: "Windsurf",
    ideVersion: "1.0.0",
    extensionName: "codeium.windsurf",
    extensionVersion: "1.0.0",
    locale,
    os: normalizedOs(),
    disableTelemetry: false,
    sessionId: `windsurf-token-usage-${ts}`,
    requestId: ts,
  };
}

// ── Response parsing ──────────────────────────────────────────────────────

function pickNum(obj: unknown, keys: string[]): number | undefined {
  if (!obj || typeof obj !== "object") {
    return undefined;
  }
  const rec = obj as Record<string, unknown>;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "number" && Number.isFinite(v)) {
      return v;
    }
    if (typeof v === "string" && v.trim() !== "") {
      const n = Number(v);
      if (Number.isFinite(n)) {
        return n;
      }
    }
  }
  return undefined;
}

function pickStr(obj: unknown, keys: string[]): string | undefined {
  if (!obj || typeof obj !== "object") {
    return undefined;
  }
  const rec = obj as Record<string, unknown>;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "string" && v.trim() !== "") {
      return v.trim();
    }
  }
  return undefined;
}

/**
 * Protobuf Timestamp comes across the JSON bridge as either `{seconds, nanos}`
 * or a plain ISO string. cockpit-tools' `parse_proto_timestamp_seconds`
 * handles both — we do the same so the reset date always reaches the UI.
 */
function unixToIso(s: string | undefined): string | undefined {
  if (!s) {
    return undefined;
  }
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) {
    return undefined;
  }
  return new Date(n * 1000).toISOString();
}

function parseResetDate(planStatus: unknown): string | undefined {
  if (!planStatus || typeof planStatus !== "object") {
    return undefined;
  }
  const rec = planStatus as Record<string, unknown>;
  const planEnd = rec["planEnd"] ?? rec["plan_end"];
  if (planEnd === undefined || planEnd === null) {
    return undefined;
  }
  if (typeof planEnd === "string") {
    return planEnd;
  }
  if (typeof planEnd === "number" && Number.isFinite(planEnd) && planEnd > 0) {
    return new Date(planEnd * 1000).toISOString();
  }
  if (typeof planEnd === "object") {
    const sub = planEnd as Record<string, unknown>;
    const seconds = Number(sub["seconds"] ?? sub["Seconds"]);
    if (Number.isFinite(seconds) && seconds > 0) {
      return new Date(seconds * 1000).toISOString();
    }
  }
  return undefined;
}

/**
 * Extract the four credit counters + optional reset/plan from a GetUserStatus
 * response. The apiKey flow always nests quota under `userStatus.planStatus`;
 * we also accept `planStatus` at the top level for forward-compatibility with
 * any cloud-side renames.
 */
function extractFromUserStatusResp(
  raw: unknown
): Omit<QuotaInfo, "source" | "method"> | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const root = raw as Record<string, unknown>;
  const userStatus =
    (root["userStatus"] as Record<string, unknown> | undefined) ??
    (root["user_status"] as Record<string, unknown> | undefined);
  const planStatus =
    (userStatus?.["planStatus"] as Record<string, unknown> | undefined) ??
    (userStatus?.["plan_status"] as Record<string, unknown> | undefined) ??
    (root["planStatus"] as Record<string, unknown> | undefined) ??
    (root["plan_status"] as Record<string, unknown> | undefined);

  if (!planStatus) {
    return null;
  }

  // Diagnostic: dump planStatus keys + values so we can see the real shape
  // the server returns — this is the key to figuring out why credit fields
  // are sometimes missing.
  try {
    const keys = Object.keys(planStatus);
    const summary = keys
      .map((k) => {
        const v = (planStatus as Record<string, unknown>)[k];
        const t = typeof v;
        if (t === "number" || t === "string" || t === "boolean") {
          return `${k}=${JSON.stringify(v)}`;
        }
        return `${k}=[${t}]`;
      })
      .join(", ");
    log(`quota: planStatus keys: { ${summary} }`);
  } catch { /* best effort */ }

  // Absolute remaining credits (for tooltip context).
  const promptRemaining = pickNum(planStatus, [
    "availablePromptCredits",
    "available_prompt_credits",
  ]);
  const flowRemaining = pickNum(planStatus, [
    "availableFlowCredits",
    "available_flow_credits",
  ]);

  // Server provides daily/weekly remaining percentages directly.
  const dailyRemainingPct = pickNum(planStatus, [
    "dailyQuotaRemainingPercent",
    "daily_quota_remaining_percent",
  ]);
  const weeklyRemainingPct = pickNum(planStatus, [
    "weeklyQuotaRemainingPercent",
    "weekly_quota_remaining_percent",
  ]);
  const dailyUsedPct =
    dailyRemainingPct !== undefined
      ? Math.max(0, Math.min(100, 100 - dailyRemainingPct))
      : undefined;
  const weeklyUsedPct =
    weeklyRemainingPct !== undefined
      ? Math.max(0, Math.min(100, 100 - weeklyRemainingPct))
      : undefined;

  // Reset timestamps — server sends Unix seconds as strings.
  const dailyResetAt = unixToIso(
    pickStr(planStatus, ["dailyQuotaResetAtUnix", "daily_quota_reset_at_unix"])
  );
  const weeklyResetAt = unixToIso(
    pickStr(planStatus, ["weeklyQuotaResetAtUnix", "weekly_quota_reset_at_unix"])
  );

  const resetDate = parseResetDate(planStatus);
  const planInfo =
    (planStatus["planInfo"] as Record<string, unknown> | undefined) ??
    (planStatus["plan_info"] as Record<string, unknown> | undefined);
  const plan =
    pickStr(planInfo, ["planName", "plan_name"]) ??
    pickStr(planInfo, ["teamsTier", "teams_tier"]) ??
    pickStr(planInfo, ["tier"]);

  // At least one useful field must be present.
  if (
    dailyUsedPct === undefined &&
    weeklyUsedPct === undefined &&
    promptRemaining === undefined &&
    flowRemaining === undefined
  ) {
    return null;
  }

  return {
    promptRemaining,
    flowRemaining,
    dailyUsedPct,
    weeklyUsedPct,
    dailyResetAt,
    weeklyResetAt,
    resetDate,
    plan,
  };
}

/**
 * Mirror of cockpit-tools' `total_prompt` / `total_flow` fallback logic:
 *   (available, used) -> Some((available + used).max(0))
 *   (available, None) -> Some(available.max(0))   // assume zero used
 *   (None, _)         -> None                      // no total available
 * Negative inputs are clamped to 0 because the server occasionally returns
 * small negatives for grace-period accounts.
 */
function computeTotal(
  remaining: number | undefined,
  used: number | undefined
): number | undefined {
  if (remaining !== undefined && used !== undefined) {
    return Math.max(0, remaining + used);
  }
  if (remaining !== undefined) {
    return Math.max(0, remaining);
  }
  return undefined;
}

// ── Remote call ───────────────────────────────────────────────────────────

/**
 * Mirror of `post_seat_management_json` in cockpit-tools. The header set is
 * deliberately minimal — adding the usual Connect-Protocol-Version: 1 that
 * our local LS calls carry makes the server reply with protocol errors.
 *
 * Returns `{ ok: true, body }` on 200 with parsed JSON, `{ ok: false, error }`
 * with a short human-readable reason otherwise. Never throws.
 */
async function callGetUserStatus(
  apiKey: string,
  apiServerUrl: string
):
  Promise<
    | { ok: true; body: unknown }
    | { ok: false; error: string }
  > {
  const base = apiServerUrl.trim().replace(/\/+$/, "");
  if (!base.startsWith("http")) {
    return { ok: false, error: `invalid apiServerUrl: ${apiServerUrl}` };
  }
  const url = `${base}/exa.seat_management_pb.SeatManagementService/GetUserStatus`;
  const body = JSON.stringify({ metadata: buildMetadata(apiKey) });
  log(`quota: POST ${url}`);
  let resp: { status: number; body: string };
  try {
    resp = await httpPost(
      url,
      {
        // Match cockpit-tools' post_seat_management_json headers exactly.
        "User-Agent": "windsurf-token-usage",
        Accept: "application/json",
      },
      body
    );
  } catch (e: unknown) {
    const msg = (e as Error)?.message ?? String(e);
    log(`quota: request failed: ${msg}`);
    return { ok: false, error: `network: ${msg}` };
  }
  if (resp.status !== 200) {
    const excerpt = resp.body.slice(0, 200).replace(/\s+/g, " ");
    log(`quota: HTTP ${resp.status} — ${excerpt}`);
    return { ok: false, error: `HTTP ${resp.status}` };
  }
  try {
    const parsed = JSON.parse(resp.body);
    return { ok: true, body: parsed };
  } catch (e: unknown) {
    log(
      `quota: JSON parse failed: ${(e as Error)?.message ?? e} — excerpt: ${resp.body.slice(0, 200)}`
    );
    return { ok: false, error: "invalid JSON from server" };
  }
}

// ── devClient reflection fallback ─────────────────────────────────────────

/**
 * Depth-limited walk over the devClient object graph looking for a Windsurf
 * API key (`sk-ws-*`). Also opportunistically captures an `apiServerUrl`
 * living nearby.
 *
 * This is the fallback when `state.vscdb` isn't readable (portable install,
 * locked file, sql.js init failure). It's best-effort — Windsurf obfuscates
 * this key and may rotate its internal layout, so we keep the walker shallow
 * and fail closed rather than scan the world.
 */
function reflectApiKey(
  root: unknown
): { apiKey: string; apiServerUrl?: string } | null {
  if (!root || typeof root !== "object") {
    return null;
  }

  const visited = new WeakSet<object>();
  let foundKey: string | null = null;
  let foundServer: string | null = null;

  const walk = (obj: unknown, depth: number): void => {
    if (foundKey && foundServer) {
      return;
    }
    if (!obj || typeof obj !== "object" || depth > 6) {
      return;
    }
    const asObj = obj as object;
    if (visited.has(asObj)) {
      return;
    }
    visited.add(asObj);

    let keys: string[];
    try {
      keys = Object.getOwnPropertyNames(asObj);
    } catch {
      return;
    }

    for (const key of keys) {
      let v: unknown;
      try {
        v = (asObj as Record<string, unknown>)[key];
      } catch {
        continue;
      }

      if (typeof v === "string") {
        if (!foundKey && v.startsWith("sk-ws-") && v.length >= 16) {
          foundKey = v;
        }
        if (
          !foundServer &&
          /apiServerUrl|api_server_url/i.test(key) &&
          /^https?:\/\//i.test(v)
        ) {
          foundServer = v;
        }
      } else if (v && typeof v === "object") {
        walk(v, depth + 1);
      }

      if (foundKey && foundServer) {
        return;
      }
    }
  };

  walk(root, 0);
  if (!foundKey) {
    return null;
  }
  return {
    apiKey: foundKey,
    apiServerUrl: foundServer ?? undefined,
  };
}

// ── Public entry point ────────────────────────────────────────────────────

/**
 * Result of a single fetchQuota attempt. Success carries a QuotaInfo; any
 * failure carries a short human-readable reason that the webview surfaces
 * in the sidebar tooltip so users see why the line shows "N/A".
 */
export interface QuotaFetchOutcome {
  quota: QuotaInfo | null;
  error: string | null;
}

async function tryWithCredentials(
  creds: { apiKey: string; apiServerUrl?: string },
  source: QuotaInfo["source"]
): Promise<QuotaFetchOutcome> {
  const server = creds.apiServerUrl?.trim() || DEFAULT_API_SERVER_URL;
  const call = await callGetUserStatus(creds.apiKey, server);
  if (!call.ok) {
    return { quota: null, error: call.error };
  }
  const extracted = extractFromUserStatusResp(call.body);
  if (!extracted) {
    log("quota: server returned 200 but planStatus was not found in response");
    return {
      quota: null,
      error: "server returned no planStatus",
    };
  }
  // Success log
  const f = (n: number | undefined) => (n === undefined ? "?" : String(n));
  log(
    `quota: OK (source=${source}) ` +
      `dailyUsed=${f(extracted.dailyUsedPct)}% weeklyUsed=${f(extracted.weeklyUsedPct)}% ` +
      `promptRemaining=${f(extracted.promptRemaining)} flowRemaining=${f(extracted.flowRemaining)} ` +
      `plan=${extracted.plan ?? "?"}`
  );
  return {
    quota: { ...extracted, source, method: "GetUserStatus" },
    error: null,
  };
}

/**
 * Best-effort quota fetch matching jlcodes99/cockpit-tools' apiKey flow:
 *
 *   1. Read `windsurfAuthStatus` from the shared VS Code `state.vscdb`
 *      (primary — authoritative, no reliance on in-memory layout).
 *   2. Fall back to reflecting an `sk-ws-*` string out of the live devClient
 *      graph (useful for portable installs where step 1 isn't wired up).
 *   3. POST to `{apiServerUrl}/exa.seat_management_pb.SeatManagementService/GetUserStatus`
 *      with the canonical `{ metadata: { apiKey, ... } }` payload and read
 *      `userStatus.planStatus` out of the response.
 *
 * Never throws. Always returns an outcome with either `quota` or `error` set.
 *
 * The `_creds` parameter is retained for API compatibility with the previous
 * LS-probing implementation; it is currently unused.
 */
export async function fetchQuota(
  _creds: WindsurfCredentials | null,
  devClient: unknown
): Promise<QuotaFetchOutcome> {
  // 1) Primary: SQLite-backed apiKey.
  let local: WindsurfLocalAuthStatus | null = null;
  try {
    local = await getLocalAuthStatus();
  } catch (e: unknown) {
    log(`quota: getLocalAuthStatus threw: ${(e as Error)?.message ?? e}`);
  }
  if (local?.apiKey && typeof local.apiKey === "string") {
    log(
      `quota: using apiKey from state.vscdb (server=${local.apiServerUrl ?? DEFAULT_API_SERVER_URL})`
    );
    const outcome = await tryWithCredentials(
      { apiKey: local.apiKey, apiServerUrl: local.apiServerUrl },
      "local-sqlite"
    );
    if (outcome.quota) {
      return outcome;
    }
    // Record the first failure so we can report a useful reason even when
    // the fallback also fails.
    const reflected = reflectApiKey(devClient);
    if (reflected) {
      log("quota: sqlite path failed, falling back to devClient reflection");
      const fb = await tryWithCredentials(reflected, "devClient-reflection");
      if (fb.quota) {
        return fb;
      }
    }
    return outcome;
  }

  // 2) Fallback: devClient reflection only.
  const reflected = reflectApiKey(devClient);
  if (reflected) {
    log("quota: using apiKey reflected from devClient");
    return tryWithCredentials(reflected, "devClient-reflection");
  }

  log("quota: no apiKey available — state.vscdb absent and devClient has no sk-ws-* string");
  return {
    quota: null,
    error: "no apiKey found (not signed in?)",
  };
}
