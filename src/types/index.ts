/**
 * Shared TypeScript types for the Education Intelligence Agent.
 */

// ── Agent Run ──────────────────────────────────────────────────────

export type AgentRunStatus = 'queued' | 'running' | 'completed' | 'failed';
export type AgentRunTrigger = 'manual' | 'scheduled' | 'cia_notification' | 'feedback_replacement' | 'add_new';

export interface AgentRunInputs {
  ciaGoals: Array<{ category: string; description: string }>;
  ciaDeltas: Array<{ label: string; direction: string; change: string }>;
  currentEducation?: string;
  location?: string;
  replacingWaypointId?: string;
}

export interface AgentRun {
  runId: string;
  userId: string;
  trigger: AgentRunTrigger;
  status: AgentRunStatus;
  inputs: AgentRunInputs;
  waypointIds: string[];
  perplexityCallCount: number;
  durationMs?: number;
  errorMessage?: string;
  startedAt: Date;
  completedAt?: Date;
}

// ── Education Waypoint ─────────────────────────────────────────────

export type CredentialType = 'degree' | 'certification' | 'bootcamp' | 'course' | 'other';
export type DeliveryMode = 'online' | 'in-person' | 'hybrid' | 'flexible';
export type WaypointStatus = 'pending' | 'accepted' | 'declined' | 'replaced';

export interface EducationWaypoint {
  waypointId: string;
  userId: string;
  credentialName: string;
  institution: string;
  credentialType: CredentialType;
  location: string;
  deliveryMode: DeliveryMode;
  projectedYear: number;
  durationMonths: number;
  tuitionMin: number;
  tuitionMax: number;
  tuitionMidpoint: number;
  salaryImpactPct: number;
  salaryRoiPerYear: number;
  rationale: string;
  position: number;
  status: WaypointStatus;
  replacedById?: string;
  agentRunId: string;
  confidence: number;
  url?: string;
  financialAid: boolean;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

// ── User Profile (from education history) ──────────────────────────

export interface UserProfile {
  userId: string;
  currentEducation?: string;
  highestDegree?: string;
  institution?: string;
  fieldOfStudy?: string;
  location?: string;
}

// ── CIA Context ────────────────────────────────────────────────────

export interface CIAContext {
  goals: Array<{ category: string; description: string; status: string; goal_text?: string }>;
  deltas: Array<{ label: string; direction: string; change: string }>;
  career_summary?: string | null;
}

// ── Education Match ────────────────────────────────────────────────

export interface EducationMatch {
  matchId: string;
  credentialName: string;
  institution: string;
  location: string;
  deliveryMode: DeliveryMode;
  tuitionMin: number;
  tuitionMax: number;
  salaryImpactPct: number;
  salaryRoiPerYear: number;
  matchPct: number;
  url: string | null;
  description: string;
  tags: string[];
  waypointCredential?: string;
}

// ── Raw waypoint data from Perplexity ──────────────────────────────

export interface RawEducationWaypoint {
  credentialName: string;
  institution: string;
  credentialType: CredentialType;
  location: string;
  deliveryMode: DeliveryMode;
  projectedYear: number;
  durationMonths: number;
  tuitionMin: number;
  tuitionMax: number;
  salaryImpactPct: number;
  salaryRoiPerYear: number;
  rationale: string;
  confidence: number;
  url?: string;
  financialAid: boolean;
  tags: string[];
  position: number;
}
