import * as vscode from "vscode";
import * as http from "http";
import type {
  WindsurfCredentials,
  TrajectorySummary,
  TokenUsage,
  ConversationStats,
  DashboardData,
} from "./types";

let cachedCreds: WindsurfCredentials | null = null;

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

    for (const step of steps) {
      if (
        step.type === "CORTEX_STEP_TYPE_USER_INPUT" &&
        step.metadata?.responseDimensionGroups
      ) {
        turns++;
        for (const group of step.metadata.responseDimensionGroups) {
          if (group.title === "Token Usage") {
            for (const dim of group.dimensions) {
              const val = dim.cumulativeMetric?.value ?? 0;
              if (dim.uid === "input_tokens") {
                usage.inputTokens += val;
              }
              if (dim.uid === "output_tokens") {
                usage.outputTokens += val;
              }
              if (dim.uid === "cached_input_tokens") {
                usage.cachedTokens += val;
              }
            }
          }
        }
      }
    }

    usage.total = usage.inputTokens + usage.outputTokens + usage.cachedTokens;

    grandTotal.inputTokens += usage.inputTokens;
    grandTotal.outputTokens += usage.outputTokens;
    grandTotal.cachedTokens += usage.cachedTokens;

    conversations.push({
      cascadeId,
      summary: summary.summary ?? "(untitled)",
      turns,
      stepCount: summary.stepCount ?? steps.length,
      model: summary.lastGeneratorModelUid ?? "unknown",
      createdTime: summary.createdTime ?? "",
      lastModifiedTime: summary.lastModifiedTime ?? "",
      usage,
    });
  }

  grandTotal.total =
    grandTotal.inputTokens + grandTotal.outputTokens + grandTotal.cachedTokens;

  // Sort by total tokens descending
  conversations.sort((a, b) => b.usage.total - a.usage.total);

  return {
    conversations,
    grandTotal,
    fetchedAt: new Date().toISOString(),
  };
}
