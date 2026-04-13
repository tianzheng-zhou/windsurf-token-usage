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
}

export interface DashboardData {
  conversations: ConversationStats[];
  grandTotal: TokenUsage;
  estimatedCost: CostEstimate;
  fetchedAt: string;
}
