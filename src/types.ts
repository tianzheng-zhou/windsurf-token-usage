export interface WindsurfCredentials {
  csrf: string;
  port: number;
}

export interface TrajectorySummary {
  summary: string;
  stepCount: number;
  lastModifiedTime: string;
  createdTime: string;
  trajectoryId: string;
  status: string;
  lastGeneratorModelUid: string;
  trajectoryType: string;
  lastUserInputTime?: string;
  workspaces?: Array<{
    workspaceFolderAbsoluteUri?: string;
    branchName?: string;
    repository?: { computedName?: string };
  }>;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  total: number;
}

export interface CostEstimate {
  inputCost: number;
  outputCost: number;
  cachedCost: number;
  totalCost: number;
}

export interface ConversationStats {
  cascadeId: string;
  summary: string;
  turns: number;
  stepCount: number;
  models: string[];
  createdTime: string;
  lastModifiedTime: string;
  usage: TokenUsage;
  estimatedCost: CostEstimate;
  /**
   * Per-day breakdown of this conversation's consumption, derived from
   * per-turn timestamps. Key is local-time YYYY-MM-DD. Absent if a prior
   * extension version populated the cache (treated as empty on read).
   */
  byDay?: Record<string, { input: number; output: number; cached: number; cost: number }>;
  /**
   * Primary workspace label for this cascade (first workspace's repo
   * computedName, or last segment of its folder URI, or "(no workspace)").
   * Absent on cache entries written by pre-0.3 versions → treated as a
   * cache miss so those conversations are re-fetched.
   */
  workspaceName?: string;
  /**
   * Deduped list of every workspace name touched by this cascade. Populated
   * alongside `workspaceName`; kept around so a future multi-select filter
   * can match a cascade against any of its workspaces.
   */
  workspaces?: string[];
  /**
   * Per-model token + cost breakdown for this conversation. Key is the
   * Windsurf model UID. Absent on pre-0.3 cache entries.
   */
  perModel?: Record<string, { input: number; output: number; cached: number; cost: number }>;
}

export interface DailyBreakdown {
  /** Local-time YYYY-MM-DD. */
  date: string;
  input: number;
  output: number;
  cached: number;
  /** Convenience sum — kept alongside the per-class breakdown for UI speed. */
  tokens: number;
  cost: number;
}

/** Per-model global aggregate across every conversation. */
export interface ModelBreakdown {
  model: string;
  input: number;
  output: number;
  cached: number;
  tokens: number;
  cost: number;
}

/** Per-workspace global aggregate across every conversation. */
export interface WorkspaceBreakdown {
  workspace: string;
  tokens: number;
  cost: number;
}

/** One failed cascade fetch with its error message, for UI surfacing. */
export interface FailedCascade {
  cascadeId: string;
  error: string;
}

export interface DashboardData {
  conversations: ConversationStats[];
  grandTotal: TokenUsage;
  estimatedCost: CostEstimate;
  fetchedAt: string;
  /** Count of cascades whose steps failed to load this refresh. */
  failedConversations: number;
  /**
   * Per-cascade error details. Same length as `failedConversations`.
   * Surfaced in the detail panel so the user can see *why* a load failed.
   */
  failedDetails: FailedCascade[];
  /** Whether this refresh bypassed the per-cascade cache. */
  fullRefresh: boolean;
  /**
   * Per-day aggregate across all conversations, sorted ascending by date.
   * Populated from per-turn timestamps — lets the UI show a real "Today"
   * number on the first run, before any cross-day history is accumulated.
   */
  byDay: DailyBreakdown[];
  /** Per-model global aggregate, sorted by cost descending. */
  byModel: ModelBreakdown[];
  /** Per-workspace global aggregate, sorted by cost descending. */
  byWorkspace: WorkspaceBreakdown[];
}
