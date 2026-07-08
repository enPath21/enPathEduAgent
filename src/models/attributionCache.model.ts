import { Schema, Model, Document } from 'mongoose';
import { mongoose } from '../config/database';

// Global cache of (job_title × credential_set) → attribution matrix.
// Populated by /enrich-job-credentials on cache miss; hit rate compounds as
// more users query the same job+credential fingerprints.
//
// Keyed by (market, normalizedJobTitle, credentialFingerprint) — see
// edu-salary-attribution-spec.md for the full model.

export interface AttributionCacheDocument extends Document {
  market: string;
  normalizedJobTitle: string;
  credentialFingerprint: string;
  attributions: Array<{
    credentialName: string;
    necessity: 'required' | 'preferred' | 'irrelevant';
    weight: number;
    confidence: number;
    reasoning: string;
  }>;
  ttlDays: number;
  sourceRunId: string | null;
  createdAt: Date;
}

const attributionCacheSchema = new Schema<AttributionCacheDocument>(
  {
    market:                { type: String, required: true },
    normalizedJobTitle:    { type: String, required: true },
    credentialFingerprint: { type: String, required: true },

    attributions: [{
      credentialName: { type: String, required: true },
      necessity:      { type: String, enum: ['required', 'preferred', 'irrelevant'], required: true },
      weight:         { type: Number, required: true },
      confidence:     { type: Number, required: true },
      reasoning:      { type: String, default: '' },
    }],

    ttlDays:      { type: Number, default: 180 },
    sourceRunId:  { type: String, default: null },
    createdAt:    { type: Date, default: () => new Date() },
  },
  { collection: 'attribution_cache' },
);

attributionCacheSchema.index(
  { market: 1, normalizedJobTitle: 1, credentialFingerprint: 1 },
  { unique: true, name: 'cache_key_unique' },
);

export const AttributionCacheModel: Model<AttributionCacheDocument> =
  mongoose.models.AttributionCache ||
  mongoose.model<AttributionCacheDocument>('AttributionCache', attributionCacheSchema);
