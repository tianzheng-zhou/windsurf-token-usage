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

export interface DashboardData {
  conversations: ConversationStats[];
  grandTotal: TokenUsage;
  estimatedCost: CostEstimate;
  fetchedAt: string;
  /** Count of cascades whose steps failed to load this refresh. */
  failedConversations: number;
  /** Whether this refresh bypassed the per-cascade cache. */
  fullRefresh: boolean;
  /**
   * Per-day aggregate across all conversations, sorted ascending by date.
   * Populated from per-turn timestamps — lets the UI show a real "Today"
   * number on the first run, before any cross-day history is accumulated.
   */
  byDay: DailyBreakdown[];
}
