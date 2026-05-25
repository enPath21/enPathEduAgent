import mongoose, { Schema, Document } from 'mongoose';

export interface IEducationWaypoint extends Document {
  userId: string;
  waypointId: string;
  credentialName: string;
  institution: string;
  credentialType: 'degree' | 'certification' | 'bootcamp' | 'course' | 'other';
  location: string;
  deliveryMode: 'online' | 'in-person' | 'hybrid' | 'flexible';
  projectedYear: number;
  durationMonths: number;
  tuitionMin: number;
  tuitionMax: number;
  tuitionMidpoint: number;
  salaryImpactPct: number;
  salaryRoiPerYear: number;
  rationale: string;
  position: number;
  status: 'pending' | 'accepted' | 'declined' | 'replaced' | 'undesired';
  replacedById?: string;
  agentRunId: string;
  confidence: number;
  url?: string;
  financialAid: boolean;
  tags: string[];
  partnerSites?: string[];
  // Sequencing intelligence
  /** 1 = required to unlock next career waypoint, 2 = strongly recommended, 3 = optional enhancement */
  priority?: 1 | 2 | 3;
  /** The job waypoint position (1–5) this credential is designed to unlock */
  unlocksJobPosition?: number;
  /** One sentence explaining why this credential comes before the next one */
  sequenceRationale?: string;
  // User-editable dates
  userStartDate?: string;
  userEndDate?: string;
  isCompleted?: boolean;
}

const schema = new Schema<IEducationWaypoint>({
  userId:          { type: String, required: true, index: true },
  waypointId:      { type: String, required: true, unique: true },
  credentialName:  { type: String, required: true },
  institution:     { type: String, default: '' },
  credentialType:  { type: String, enum: ['degree','certification','bootcamp','course','other'], default: 'course' },
  location:        { type: String, default: '' },
  deliveryMode:    { type: String, enum: ['online','in-person','hybrid','flexible'], default: 'online' },
  projectedYear:   { type: Number },
  durationMonths:  { type: Number },
  tuitionMin:      { type: Number, default: 0 },
  tuitionMax:      { type: Number, default: 0 },
  tuitionMidpoint: { type: Number, default: 0 },
  salaryImpactPct: { type: Number, default: 0 },
  salaryRoiPerYear:{ type: Number, default: 0 },
  rationale:       { type: String, default: '' },
  position:        { type: Number, default: 0 },
  status:          { type: String, enum: ['pending','accepted','declined','replaced','undesired'], default: 'pending' },
  replacedById:    { type: String },
  agentRunId:      { type: String, required: true },
  confidence:      { type: Number, default: 0.8 },
  url:             { type: String },
  financialAid:    { type: Boolean, default: false },
  tags:            [{ type: String }],
  partnerSites:    [{ type: String }],
  // Sequencing intelligence
  priority:            { type: Number, enum: [1, 2, 3], default: null },
  unlocksJobPosition:  { type: Number, default: null },
  sequenceRationale:   { type: String, default: null },
  // User-editable dates
  userStartDate: { type: String, default: null },
  userEndDate:   { type: String, default: null },
  isCompleted:   { type: Boolean, default: false },
}, {
  timestamps: true,
  collection: 'education_waypoints',
});

// Primary: fetch all waypoints for a user, ordered by timeline position
schema.index({ userId: 1, position: 1 });
// For feedback queries — find pending/accepted waypoints
schema.index({ userId: 1, status: 1 });
// For replacement lookups
schema.index({ replacedById: 1 }, { sparse: true });

export const EducationWaypointModel = mongoose.model<IEducationWaypoint>('EducationWaypoint', schema);
