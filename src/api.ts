import * as vscode from "vscode";
import * as http from "http";
import type {
  WindsurfCredentials,
  TrajectorySummary,
  TokenUsage,
  CostEstimate,
  ConversationStats,
  DashboardData,
} from "./types";

let cachedCreds: WindsurfCredentials | null = null;

// ── Model Pricing ($ per 1M tokens) ─────────────────────────────────────────

interface ModelPricing {
  input: number;
  output: number;
  cached: number;
}

const FREE: ModelPricing = { input: 0, output: 0, cached: 0 };

const PRICING_TABLE: Array<{ match: (uid: string) => boolean; pricing: ModelPricing }> = [
  // ── Free models ──
  { match: (u) => /phoenix/i.test(u),             pricing: FREE },
  { match: (u) => /kimi.?k2.?5/i.test(u),         pricing: FREE },

  // ── Windsurf ──
  { match: (u) => /swe.?1.?5.*fast/i.test(u),     pricing: { input: 0.30, output: 1.50, cached: 0.03 } },
  { match: (u) => /swe.?1.?5/i.test(u),            pricing: FREE },
  { match: (u) => /fast.?arena/i.test(u),           pricing: { input: 0.10, output: 0.50, cached: 0 } },
  { match: (u) => /hybrid.?arena/i.test(u),         pricing: { input: 1.00, output: 5.00, cached: 0.10 } },
  { match: (u) => /frontier.?arena/i.test(u),       pricing: { input: 3.00, output: 15.00, cached: 0 } },

  // ── Anthropic ──
  // Opus 4.6 Fast — Anthropic fast mode (6x standard pricing). As of Apr 2026,
  // fast mode is only confirmed for 4.6; add 4.7 Fast here if/when it launches.
  { match: (u) => /opus.?4.?6.*fast/i.test(u),     pricing: { input: 30, output: 150, cached: 3.00 } },
  // Opus 4.x standard (covers 4.5 / 4.6 / 4.7): $5 / $25 / $0.50 per 1M
  { match: (u) => /opus.?4/i.test(u),               pricing: { input: 5, output: 25, cached: 0.50 } },
  { match: (u) => /haiku/i.test(u),                 pricing: { input: 1, output: 5, cached: 0.10 } },
  { match: (u) => /sonnet.?4/i.test(u),             pricing: { input: 3, output: 15, cached: 0.30 } },

  // ── OpenAI ──
  { match: (u) => /gpt.?4o/i.test(u),              pricing: { input: 2.50, output: 10, cached: 1.25 } },
  { match: (u) => /gpt.?4.?1/i.test(u),            pricing: { input: 2, output: 8, cached: 0.50 } },
  { match: (u) => /o3/i.test(u),                    pricing: { input: 2, output: 8, cached: 0.50 } },
  // GPT-5.1-Codex-Mini
  { match: (u) => /gpt.?5.?1.?codex.?mini/i.test(u), pricing: { input: 0.25, output: 2, cached: 0.03 } },
  // GPT-5-Codex / GPT-5.1-Codex
  { match: (u) => /gpt.?5([.-]?[01])?.?codex/i.test(u), pricing: { input: 1.25, output: 10, cached: 0.13 } },
  // GPT-5.2 / 5.3 Fast
  { match: (u) => /gpt.?5.?[23].*fast/i.test(u),   pricing: { input: 3.50, output: 28, cached: 0.35 } },
  // GPT-5.2 / 5.3 non-Fast
  { match: (u) => /gpt.?5.?[23]/i.test(u),          pricing: { input: 1.75, output: 14, cached: 0.17 } },
  // GPT-5.4 Mini
  { match: (u) => /gpt.?5.?4.*mini/i.test(u),      pricing: { input: 0.75, output: 4, cached: 0.07 } },
  // GPT-5.4 Fast (non-Mini)
  { match: (u) => /gpt.?5.?4.*fast/i.test(u),      pricing: { input: 5, output: 30, cached: 0.50 } },
  // GPT-5.4
  { match: (u) => /gpt.?5.?4/i.test(u),             pricing: { input: 2.50, output: 15, cached: 0.25 } },

  // ── Google ──
  { match: (u) => /gemini.?2.?5.?pro/i.test(u),    pricing: { input: 1.25, output: 10, cached: 0.13 } },
  { match: (u) => /gemini.?3.*flash/i.test(u),      pricing: { input: 0.50, output: 3, cached: 0.05 } },
  { match: (u) => /gemini.?3.*pro/i.test(u),        pricing: { input: 2, output: 12, cached: 0.20 } },

  // ── xAI ──
  { match: (u) => /grok.?code.*fast/i.test(u),     pricing: { input: 0.20, output: 1.50, cached: 0.02 } },
  { match: (u) => /grok.?3.*mini/i.test(u),         pricing: { input: 0.30, output: 0.50, cached: 0 } },
  { match: (u) => /grok.?3/i.test(u),               pricing: { input: 3, output: 15, cached: 0 } },

  // ── Moonshot ──
  { match: (u) => /kimi.?k2/i.test(u),              pricing: { input: 0.60, output: 2.50, cached: 0.15 } },
];

function getModelPricing(modelUid: string): ModelPricing | null {
  for (const entry of PRICING_TABLE) {
    if (entry.match(modelUid)) {
      return entry.pricing;
    }
  }
  return null;
}

// ── CSRF Token Extraction ──────────────────────────────────────────────────

async function validateCredentials(creds: WindsurfCredentials): Promise<boolean> {
  try {
    const resp = await httpPost(
      `http://127.0.0.1:${creds.port}/exa.language_server_pb.LanguageServerService/GetProcesses`,
      { "x-codeium-csrf-token": creds.csrf },
      "{}"
    );
    return resp.status === 200;
  } catch {
    return false;
  }
}

export async function getCredentials(): Promise<WindsurfCredentials | null> {
  if (cachedCreds) {
    if (await validateCredentials(cachedCreds)) {
      return cachedCreds;
    }
    cachedCreds = null;
  }
  cachedCreds = await extractCsrf();
  return cachedCreds;
}

export function clearCredentials(): void {
  cachedCreds = null;
}

async function extractCsrf(): Promise<WindsurfCredentials | null> {
  // Get devClient from codeium.windsurf extension
  const ext = vscode.extensions.getExtension("codeium.windsurf");
  if (!ext?.isActive) {
    return null;
  }

  const exports = ext.exports;
  if (!exports || typeof exports.devClient !== "function") {
    return null;
  }

  // Retry until devClient is available (LS may still be starting)
  let devClient: any = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    devClient = exports.devClient();
    if (devClient) {
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!devClient) {
    return null;
  }

  // Strategy 1 — side-effect-free reflection over devClient internals.
  // The reflected result MUST be validated against the LS; a false positive
  // (e.g. a stale "csrfDefault" constant + unrelated port) would otherwise
  // poison the cache and every subsequent API call.
  const reflected = tryExtractFromReflection(devClient);
  if (reflected && (await validateCredentials(reflected))) {
    return reflected;
  }

  // Strategy 2 — scoped ClientRequest.prototype.end patch as fallback.
  const patched = await extractViaHttpPatch(devClient);
  if (patched && (await validateCredentials(patched))) {
    return patched;
  }
  return null;
}

/**
 * Walk devClient's object graph looking for an `x-codeium-csrf-token` header
 * value and a local `127.0.0.1:PORT` URL. Bounded depth, visited-set guarded,
 * and fully non-mutating — safe to call before any HTTP traffic.
 */
function tryExtractFromReflection(root: any): WindsurfCredentials | null {
  const visited = new WeakSet<object>();
  let foundCsrf = "";
  let foundPort = 0;

  const walk = (obj: any, depth: number): void => {
    if (!obj || typeof obj !== "object" || visited.has(obj) || depth > 5) {
      return;
    }
    visited.add(obj);

    // Direct header containers commonly used by Connect / gRPC-web clients.
    for (const hk of ["headers", "defaultHeaders", "_headers", "metadata"]) {
      const h = (obj as any)[hk];
      if (h && typeof h === "object") {
        for (const k of Object.keys(h)) {
          if (/^x-codeium-csrf-token$/i.test(k)) {
            const v = (h as any)[k];
            if (!foundCsrf && typeof v === "string" && v.length >= 16) {
              foundCsrf = v;
            }
          }
        }
      }
    }

    let keys: string[];
    try {
      keys = Object.getOwnPropertyNames(obj);
    } catch {
      return;
    }

    for (const key of keys) {
      let v: any;
      try {
        v = obj[key];
      } catch {
        continue;
      }

      if (typeof v === "string") {
        if (!foundCsrf && /csrf/i.test(key) && v.length >= 16) {
          foundCsrf = v;
        }
        if (!foundPort) {
          const m = v.match(/127\.0\.0\.1:(\d+)|localhost:(\d+)/i);
          if (m) {
            foundPort = Number(m[1] || m[2]);
          }
        }
      } else if (typeof v === "number" && !foundPort && /port/i.test(key)) {
        if (Number.isInteger(v) && v > 1024 && v < 65536) {
          foundPort = v;
        }
      } else if (v && typeof v === "object") {
        walk(v, depth + 1);
      }

      if (foundCsrf && foundPort) {
        return;
      }
    }
  };

  try {
    walk(root, 0);
  } catch {
    return null;
  }

  if (foundCsrf && foundPort) {
    return { csrf: foundCsrf, port: foundPort };
  }
  return null;
}

/**
 * Minimum-blast-radius fallback: patch only ClientRequest.prototype.end, only
 * while `active === true`, and only inspect headers on requests targeting the
 * local loopback interface. Any other traffic from any other extension passes
 * through untouched. All probe logic is wrapped so it cannot break the
 * original request even if Windsurf changes header shape.
 */
async function extractViaHttpPatch(devClient: any): Promise<WindsurfCredentials | null> {
  let capturedCsrf = "";
  let capturedPort = 0;
  let active = true;

  const origEnd = http.ClientRequest.prototype.end;

  function patchedEnd(this: http.ClientRequest, ...args: any[]) {
    if (active && !capturedCsrf) {
      try {
        const host = this.getHeader("host");
        if (host && /^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(String(host))) {
          const csrf = this.getHeader("x-codeium-csrf-token");
          if (csrf) {
            capturedCsrf = String(csrf);
            const pm = String(host).match(/:(\d+)/);
            if (pm) {
              capturedPort = Number(pm[1]);
            }
          }
        }
      } catch {
        /* instrumentation must never break the request */
      }
    }
    return origEnd.apply(this, args as any);
  }

  try {
    http.ClientRequest.prototype.end = patchedEnd as any;

    const methods = Object.keys(devClient);
    for (const methodName of methods) {
      if (typeof devClient[methodName] !== "function") {
        continue;
      }
      try {
        await Promise.race([
          devClient[methodName]({}),
          new Promise((_, rej) =>
            setTimeout(() => rej(new Error("devClient timeout")), 5000)
          ),
        ]);
      } catch {
        /* expected — we only need the intercepted header */
      }
      if (capturedCsrf) {
        break;
      }
    }
  } finally {
    active = false;
    http.ClientRequest.prototype.end = origEnd;
  }

  if (capturedCsrf && capturedPort) {
    return { csrf: capturedCsrf, port: capturedPort };
  }
  return null;
}

// ── HTTP Helper ────────────────────────────────────────────────────────────

function httpPost(
  url: string,
  extraHeaders: Record<string, string>,
  body: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const u = new URL(url);

    const hardTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        req.destroy();
        reject(new Error("timeout (hard)"));
      }
    }, 10000);

    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Connect-Protocol-Version": "1",
          ...extraHeaders,
        },
        timeout: 5000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (!settled) {
            settled = true;
            clearTimeout(hardTimer);
            resolve({ status: res.statusCode ?? 0, body: data });
          }
        });
      }
    );
    req.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(hardTimer);
        reject(err);
      }
    });
    req.on("timeout", () => {
      if (!settled) {
        settled = true;
        clearTimeout(hardTimer);
        req.destroy();
        reject(new Error("timeout"));
      }
    });
    req.write(body);
    req.end();
  });
}

// ── API Queries ────────────────────────────────────────────────────────────

async function apiCall(
  creds: WindsurfCredentials,
  method: string,
  body: object
): Promise<any> {
  const resp = await httpPost(
    `http://127.0.0.1:${creds.port}/exa.language_server_pb.LanguageServerService/${method}`,
    { "x-codeium-csrf-token": creds.csrf },
    JSON.stringify(body)
  );
  if (resp.status !== 200) {
    throw new Error(`API ${method}: HTTP ${resp.status} — ${resp.body.slice(0, 200)}`);
  }
  return JSON.parse(resp.body);
}

// ── Per-cascade incremental cache ──────────────────────────────────────────
//
// The server's `lastModifiedTime` on each trajectory summary is our cache key.
// When it matches a previously computed ConversationStats, we can skip the
// expensive GetCascadeTrajectorySteps call and reuse the cached result.
//
// `clearConversationCache()` is exposed so a "Full Refresh" command can opt
// out of incremental caching without forcing a restart.

interface CacheEntry {
  lastModifiedTime: string;
  stats: ConversationStats;
}

const conversationCache: Map<string, CacheEntry> = new Map();

export function clearConversationCache(): void {
  conversationCache.clear();
}

type CascadeResult =
  | { ok: true; stats: ConversationStats; fromCache: boolean }
  | { ok: false; cascadeId: string; error: string };

export interface FetchOptions {
  /** When true, bypass the per-cascade cache and re-fetch every trajectory. */
  force?: boolean;
}

export async function fetchDashboardData(
  options: FetchOptions = {}
): Promise<DashboardData> {
  const force = options.force === true;

  const creds = await getCredentials();
  if (!creds) {
    throw new Error(
      "Could not obtain Windsurf CSRF token. Make sure you are running in Windsurf."
    );
  }

  // Fetch all trajectory summaries (always cheap; this is the source of truth
  // for lastModifiedTime that the cache keys off of).
  const trajResp = await apiCall(creds, "GetAllCascadeTrajectories", {
    include_user_inputs: false,
  });

  const summariesMap: Record<string, TrajectorySummary> =
    trajResp.trajectorySummaries ?? {};
  const cascadeIds = Object.keys(summariesMap);

  const conversations: ConversationStats[] = [];
  const grandCost: CostEstimate = { inputCost: 0, outputCost: 0, cachedCost: 0, totalCost: 0 };
  const grandTotal: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    total: 0,
  };
  let failed = 0;

  // Fetch steps for each trajectory (parallel, max 5 concurrent)
  const CONCURRENCY = 5;
  const entries = cascadeIds.map((id) => ({ cascadeId: id, summary: summariesMap[id] }));

  async function processCascade(
    c: WindsurfCredentials,
    entry: { cascadeId: string; summary: TrajectorySummary }
  ): Promise<CascadeResult> {
    const { cascadeId, summary } = entry;
    const lastMod = summary.lastModifiedTime ?? "";

    // Incremental path: reuse cached stats if the trajectory hasn't changed.
    if (!force && lastMod) {
      const cached = conversationCache.get(cascadeId);
      if (cached && cached.lastModifiedTime === lastMod) {
        return { ok: true, stats: cached.stats, fromCache: true };
      }
    }

    let stepsData: any;
    try {
      stepsData = await apiCall(c, "GetCascadeTrajectorySteps", {
        cascade_id: cascadeId,
      });
    } catch (err: any) {
      return { ok: false, cascadeId, error: String(err?.message ?? err) };
    }

    const steps: any[] = stepsData.steps ?? [];
    const usage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      total: 0,
    };
    let turns = 0;
    const perModelUsage: Record<string, { input: number; output: number; cached: number }> = {};

    for (const step of steps) {
      if (
        step.type === "CORTEX_STEP_TYPE_USER_INPUT" &&
        step.metadata?.responseDimensionGroups
      ) {
        turns++;
        const modelUid =
          step.metadata.requestedModelUid ??
          summary.lastGeneratorModelUid ??
          "unknown";
        let turnInput = 0, turnOutput = 0, turnCached = 0;

        for (const group of step.metadata.responseDimensionGroups) {
          if (group.title === "Token Usage") {
            for (const dim of group.dimensions) {
              const val = dim.cumulativeMetric?.value ?? 0;
              if (dim.uid === "input_tokens") {
                usage.inputTokens += val;
                turnInput = val;
              }
              if (dim.uid === "output_tokens") {
                usage.outputTokens += val;
                turnOutput = val;
              }
              if (dim.uid === "cached_input_tokens") {
                usage.cachedTokens += val;
                turnCached = val;
              }
            }
          }
        }

        if (!perModelUsage[modelUid]) {
          perModelUsage[modelUid] = { input: 0, output: 0, cached: 0 };
        }
        perModelUsage[modelUid].input += turnInput;
        perModelUsage[modelUid].output += turnOutput;
        perModelUsage[modelUid].cached += turnCached;
      }
    }

    usage.total = usage.inputTokens + usage.outputTokens + usage.cachedTokens;

    // Estimated cost for this conversation
    const estCost: CostEstimate = { inputCost: 0, outputCost: 0, cachedCost: 0, totalCost: 0 };
    for (const [uid, mu] of Object.entries(perModelUsage)) {
      const p = getModelPricing(uid);
      if (!p) {
        continue;
      }
      estCost.inputCost += (mu.input / 1_000_000) * p.input;
      estCost.outputCost += (mu.output / 1_000_000) * p.output;
      estCost.cachedCost += (mu.cached / 1_000_000) * p.cached;
    }
    estCost.totalCost = estCost.inputCost + estCost.outputCost + estCost.cachedCost;

    const stats: ConversationStats = {
      cascadeId,
      summary: summary.summary ?? "(untitled)",
      turns,
      stepCount: summary.stepCount ?? steps.length,
      models: Object.keys(perModelUsage),
      createdTime: summary.createdTime ?? "",
      lastModifiedTime: lastMod,
      usage,
      estimatedCost: estCost,
    };

    if (lastMod) {
      conversationCache.set(cascadeId, { lastModifiedTime: lastMod, stats });
    }

    return { ok: true, stats, fromCache: false };
  }

  // Run with concurrency limit
  for (let i = 0; i < entries.length; i += CONCURRENCY) {
    const batch = entries.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((e) => processCascade(creds, e)));
    for (const r of results) {
      if (!r.ok) {
        failed++;
        continue;
      }
      const conv = r.stats;
      grandTotal.inputTokens += conv.usage.inputTokens;
      grandTotal.outputTokens += conv.usage.outputTokens;
      grandTotal.cachedTokens += conv.usage.cachedTokens;
      grandCost.inputCost += conv.estimatedCost.inputCost;
      grandCost.outputCost += conv.estimatedCost.outputCost;
      grandCost.cachedCost += conv.estimatedCost.cachedCost;
      conversations.push(conv);
    }
  }

  grandTotal.total =
    grandTotal.inputTokens + grandTotal.outputTokens + grandTotal.cachedTokens;
  grandCost.totalCost =
    grandCost.inputCost + grandCost.outputCost + grandCost.cachedCost;

  // Sort by total tokens descending
  conversations.sort((a, b) => b.usage.total - a.usage.total);

  // Evict cache entries for trajectories that no longer exist server-side
  // (e.g. the user deleted a conversation). Keeps memory bounded and the
  // dashboard consistent with reality.
  if (cascadeIds.length > 0) {
    const live = new Set(cascadeIds);
    for (const key of conversationCache.keys()) {
      if (!live.has(key)) {
        conversationCache.delete(key);
      }
    }
  }

  return {
    conversations,
    grandTotal,
    estimatedCost: grandCost,
    fetchedAt: new Date().toISOString(),
    failedConversations: failed,
    fullRefresh: force,
  };
}
