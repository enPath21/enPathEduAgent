import { Schema, Model, Document } from 'mongoose';
import { mongoose } from '../config/database';
import type { AgentRunStatus, AgentRunTrigger } from '../types';

export interface AgentRunDocument
  extends Document {
  userId: string;
  trigger: AgentRunTrigger;
  status: AgentRunStatus;
  inputs: {
    ciaGoals: Array<{ category: string; description: string }>;
    ciaDeltas: Array<{ label: string; direction: string; change: string }>;
    currentEducation?: string | null;
    location?: string | null;
    replacingWaypointId?: string | null;
  };
  waypointIds: string[];
  perplexityCallCount: number;
  durationMs: number | null;
  errorMessage: string | null;
  startedAt: Date;
  completedAt: Date | null;
}

const agentRunSchema = new Schema<AgentRunDocument>(
  {
    userId: { type: String, required: true, index: true },

    trigger: {
      type: String,
      required: true,
      enum: ['manual', 'scheduled', 'cia_notification', 'feedback_replacement', 'add_new'] satisfies AgentRunTrigger[],
    },

    status: {
      type: String,
      required: true,
      enum: ['queued', 'running', 'completed', 'failed'] satisfies AgentRunStatus[],
      default: 'queued',
    },

    inputs: {
      ciaGoals: [{ category: String, description: String }],
      ciaDeltas: [{ label: String, direction: String, change: String }],
      currentEducation:      { type: String, default: null },
      location:              { type: String, default: null },
      replacingWaypointId:   { type: String, default: null },
    },

    waypointIds:          { type: [String], default: [] },
    perplexityCallCount:  { type: Number, default: 0 },
    durationMs:           { type: Number, default: null },
    errorMessage:         { type: String, default: null },
    startedAt:            { type: Date, required: true },
    completedAt:          { type: Date, default: null },
  },
  {
    timestamps: false,
    collection: 'agent_runs',
  },
);

// Recent runs per user — for dashboard + debugging
agentRunSchema.index({ userId: 1, startedAt: -1 });

export const AgentRunModel: Model<AgentRunDocument> =
  mongoose.model<AgentRunDocument>('AgentRun', agentRunSchema);
