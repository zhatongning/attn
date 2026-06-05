export type Confidence = "exact" | "inferred" | "unknown" | "unavailable";
export type SessionState = "needsAttention" | "inspect" | "running" | "idle" | "unknown" | "dismissable";
export type JumpAvailability = "exact" | "approximate" | "unavailable";
export type JumpTarget = "desktop" | "cli" | "unknown";

export interface SessionRow {
  sessionId: string;
  label: string;
  agentName?: string;
  projectName?: string;
  workspacePath?: string;
  lastActivityAt?: string;
  state: SessionState;
  confidence: Confidence;
  statusReason: string;
  dismissabilityReason?: string;
  handled: boolean;
  dismissed: boolean;
  jumpAvailability: JumpAvailability;
  jumpTarget: JumpTarget;
}

export interface SourceHealth {
  sourceName: string;
  status: "available" | "degraded" | "unknown";
  capabilities: Array<{
    name: string;
    availability: Confidence;
    detail: string;
  }>;
}
