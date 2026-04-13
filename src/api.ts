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
  { match: (u) => /opus.?4.?6.*fast/i.test(u),     pricing: { input: 30, output: 150, cached: 3.00 } },
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

export async function getCredentials(): Promise<WindsurfCredentials | null> {
  if (cachedCreds) {
    // Validate cached creds still work
    try {
      const resp = await httpPost(
        `http://127.0.0.1:${cachedCreds.port}/exa.language_server_pb.LanguageServerService/GetProcesses`,
        { "x-codeium-csrf-token": cachedCreds.csrf },
        "{}"
      );
      if (resp.status === 200) {
        return cachedCreds;
      }
    } catch {
      /* fall through to re-extract */
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

  // Patch ClientRequest.prototype.end to capture CSRF header
  let capturedCsrf = "";
  let capturedPort = 0;
  const origEnd = http.ClientRequest.prototype.end;
  const origWrite = http.ClientRequest.prototype.write;

  try {
    http.ClientRequest.prototype.end = function patchedEnd(
      this: http.ClientRequest,
      ...args: any[]
    ) {
      try {
        const csrf = this.getHeader("x-codeium-csrf-token");
        if (csrf && !capturedCsrf) {
          capturedCsrf = String(csrf);
          const hostHeader = this.getHeader("host");
          if (hostHeader) {
            const pm = String(hostHeader).match(/:(\d+)/);
            if (pm) {
              capturedPort = Number(pm[1]);
            }
          }
        }
      } catch {
        /* skip */
      }
      return origEnd.apply(this, args as any);
    };

    http.ClientRequest.prototype.write = function patchedWrite(
      this: http.ClientRequest,
      ...args: any[]
    ) {
      try {
        const csrf = this.getHeader("x-codeium-csrf-token");
        if (csrf && !capturedCsrf) {
          capturedCsrf = String(csrf);
          const hostHeader = this.getHeader("host");
          if (hostHeader) {
            const pm = String(hostHeader).match(/:(\d+)/);
            if (pm) {
              capturedPort = Number(pm[1]);
            }
          }
        }
      } catch {
        /* skip */
      }
      return origWrite.apply(this, args as any);
    };

    // Trigger an HTTP request through the devClient
    const methods = Object.keys(devClient);
    for (const methodName of methods) {
      if (typeof devClient[methodName] === "function") {
        try {
          await devClient[methodName]({});
        } catch {
          /* expected — we only need the intercepted headers */
        }
        if (capturedCsrf) {
          break;
        }
      }
    }
  } finally {
    http.ClientRequest.prototype.end = origEnd;
    http.ClientRequest.prototype.write = origWrite;
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
    const u = new URL(url);
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
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: data })
        );
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
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

export async function fetchDashboardData(): Promise<DashboardData> {
  const creds = await getCredentials();
  if (!creds) {
    throw new Error(
      "Could not obtain Windsurf CSRF token. Make sure you are running in Windsurf."
    );
  }

  // Fetch all trajectory summaries
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

  // Fetch steps for each trajectory and extract token usage
  for (const cascadeId of cascadeIds) {
    const summary = summariesMap[cascadeId];

    let stepsData: any;
    try {
      stepsData = await apiCall(creds, "GetCascadeTrajectorySteps", {
        cascade_id: cascadeId,
      });
    } catch {
      continue;
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

    grandTotal.inputTokens += usage.inputTokens;
    grandTotal.outputTokens += usage.outputTokens;
    grandTotal.cachedTokens += usage.cachedTokens;
    grandCost.inputCost += estCost.inputCost;
    grandCost.outputCost += estCost.outputCost;
    grandCost.cachedCost += estCost.cachedCost;

    conversations.push({
      cascadeId,
      summary: summary.summary ?? "(untitled)",
      turns,
      stepCount: summary.stepCount ?? steps.length,
      models: Object.keys(perModelUsage),
      createdTime: summary.createdTime ?? "",
      lastModifiedTime: summary.lastModifiedTime ?? "",
      usage,
      estimatedCost: estCost,
    });
  }

  grandTotal.total =
    grandTotal.inputTokens + grandTotal.outputTokens + grandTotal.cachedTokens;
  grandCost.totalCost =
    grandCost.inputCost + grandCost.outputCost + grandCost.cachedCost;

  // Sort by total tokens descending
  conversations.sort((a, b) => b.usage.total - a.usage.total);

  return {
    conversations,
    grandTotal,
    estimatedCost: grandCost,
    fetchedAt: new Date().toISOString(),
  };
}
