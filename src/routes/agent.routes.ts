/**
 * Agent Routes
 *
 * POST /api/agent/run/:userId                      — trigger a full agent run (3-5 waypoints)
 * GET  /api/agent/waypoints/:userId                — fetch the user's education waypoint timeline
 * GET  /api/agent/runs/:userId                     — fetch recent agent run history
 * PATCH /api/agent/waypoints/:id/feedback          — accept or decline a waypoint
 * POST /api/agent/waypoints/undo-replace           — undo a waypoint replacement
 * POST /api/agent/waypoints/replace-with-suggestion — accept a regenerated suggestion
 * POST /api/agent/waypoints/regenerate-one         — generate 1 replacement with feedback
 */

import { Router, Request, Response } from 'express';
import { Queue } from 'bullmq';
import { v4 as uuidv4 } from 'uuid';
import { getRedis } from '../config/redis';
import { EducationWaypointModel } from '../models/educationWaypoint.model';
import { AgentRunModel } from '../models/agentRun.model';
import { ENV } from '../config/env';
import { createLogger } from '../config/logger';
import { findEducationMatches } from '../services/educationMatch.service';
import { postAuditEvent } from '../services/agent.service';
import type { UserProfile, CIAContext } from '../types';

const log = createLogger('agent-routes');
const router = Router();

// ── Auth middleware ──────────────────────────────────────────────
function requireApiKey(req: Request, res: Response, next: () => void) {
  const key = req.headers['x-api-key'];
  if (key !== ENV.INTERNAL_API_KEY) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

// ── Queue ────────────────────────────────────────────────────────
function getAgentQueue(): Queue {
  return new Queue('edu-agent', { connection: getRedis() });
}

// ── POST /api/agent/run/:userId ──────────────────────────────────
router.post('/run/:userId', requireApiKey, async (req: Request, res: Response) => {
  const { userId } = req.params;
  const trigger = req.body?.trigger || 'manual';
  const credentialTypes: string[] = req.body?.credentialTypes || [];
  const lastAcceptedYear: number | undefined = req.body?.lastAcceptedYear;

  try {
    const queue = getAgentQueue();
    const job = await queue.add(
      'run-agent',
      { userId, trigger, credentialTypes, lastAcceptedYear },
      {
        attempts: 2,
        backoff: { type: 'fixed', delay: 10000 },
        removeOnComplete: { count: 50 },
        removeOnFail: { count: 20 },
      },
    );
    log.info({ userId, jobId: job.id }, 'Agent run enqueued');
    res.json({ queued: true, jobId: job.id, userId });
  } catch (err) {
    log.error({ err, userId }, 'Failed to enqueue agent run');
    res.status(500).json({ error: 'Failed to enqueue agent run' });
  }
});

// ── GET /api/agent/waypoints/:userId ────────────────────────────
router.get('/waypoints/:userId', requireApiKey, async (req: Request, res: Response) => {
  const { userId } = req.params;
  const { includeDeclined } = req.query;

  try {
    const statusFilter = includeDeclined === 'true'
      ? { $in: ['pending', 'accepted', 'declined', 'replaced'] }
      : { $in: ['pending', 'accepted'] };

    const waypoints = await EducationWaypointModel.find({
      userId,
      status: statusFilter,
    })
      .sort({ position: 1, createdAt: -1 })
      .lean();

    const shaped = waypoints.map(w => ({
      ...w,
      waypointId: w.waypointId || String(w._id),
      _id: undefined,
    }));

    res.json({ userId, waypoints: shaped });
  } catch (err) {
    log.error({ err, userId }, 'Failed to fetch waypoints');
    res.status(500).json({ error: 'Failed to fetch waypoints' });
  }
});

// ── GET /api/agent/runs/:userId ──────────────────────────────────
router.get('/runs/:userId', requireApiKey, async (req: Request, res: Response) => {
  const { userId } = req.params;
  try {
    const runs = await AgentRunModel.find({ userId })
      .sort({ startedAt: -1 })
      .limit(10)
      .lean();

    res.json({ userId, runs: runs.map(r => ({ ...r, runId: String(r._id), _id: undefined })) });
  } catch (err) {
    log.error({ err, userId }, 'Failed to fetch runs');
    res.status(500).json({ error: 'Failed to fetch runs' });
  }
});

// ── PATCH /api/agent/waypoints/:id/feedback ─────────────────────
router.patch('/waypoints/:id/feedback', requireApiKey, async (req: Request, res: Response) => {
  const { id } = req.params;
  const { action, note, userId, projectedYear } = req.body as {
    action: 'accept' | 'decline';
    note?: string;
    userId: string;
    projectedYear?: number;
  };

  if (!action || !['accept', 'decline'].includes(action)) {
    res.status(400).json({ error: 'action must be "accept" or "decline"' });
    return;
  }
  if (!userId) {
    res.status(400).json({ error: 'userId is required' });
    return;
  }

  try {
    const waypoint = await EducationWaypointModel.findOne({ $or: [{ waypointId: id }, { _id: id }], userId }).catch(() => EducationWaypointModel.findOne({ waypointId: id, userId }));
    if (!waypoint) {
      res.status(404).json({ error: 'Waypoint not found' });
      return;
    }

    if (action === 'accept') {
      waypoint.status = 'accepted';
      if (projectedYear !== undefined && projectedYear !== null) {
        waypoint.projectedYear = projectedYear;
      }
      await waypoint.save();
      log.info({ id, userId }, 'Waypoint accepted');
      res.json({ success: true, status: 'accepted' });
      return;
    }

    // Decline — record the note and enqueue a replacement
    waypoint.status = 'declined';
    await waypoint.save();

    // Enqueue replacement run
    const queue = getAgentQueue();
    await queue.add(
      'run-agent',
      { userId, trigger: 'feedback_replacement', replacingWaypointId: id },
      {
        attempts: 2,
        backoff: { type: 'fixed', delay: 5000 },
        removeOnComplete: { count: 50 },
        removeOnFail: { count: 20 },
      },
    );

    log.info({ id, userId }, 'Waypoint declined — replacement enqueued');
    res.json({ success: true, status: 'declined', replacementQueued: true });
  } catch (err) {
    log.error({ err, id }, 'Feedback update failed');
    res.status(500).json({ error: 'Feedback update failed' });
  }
});

// ── POST /api/agent/waypoints/undo-replace ──────────────────────
router.post('/waypoints/undo-replace', requireApiKey, async (req: Request, res: Response) => {
  const { removedWaypointId, addedWaypointId } = req.body as {
    removedWaypointId: string;
    addedWaypointId: string;
  };

  if (!removedWaypointId || !addedWaypointId) {
    res.status(400).json({ error: 'removedWaypointId and addedWaypointId are required' });
    return;
  }

  try {
    const removed = await EducationWaypointModel.findById(removedWaypointId);
    if (!removed) {
      res.status(404).json({ error: 'Removed waypoint not found' });
      return;
    }

    await EducationWaypointModel.findByIdAndUpdate(removedWaypointId, {
      $set: { status: 'accepted' },
      $unset: { replacedById: 1 },
    });

    await EducationWaypointModel.findByIdAndDelete(addedWaypointId);

    log.info({ removedWaypointId, addedWaypointId }, 'Waypoint replacement undone');
    res.json({ success: true, restoredWaypointId: removedWaypointId });
  } catch (err) {
    log.error({ err, removedWaypointId, addedWaypointId }, 'Undo replace failed');
    res.status(500).json({ error: 'Undo replace failed' });
  }
});

// ── POST /api/agent/waypoints/regenerate-one ───────────────────
router.post('/waypoints/regenerate-one', requireApiKey, async (req: Request, res: Response) => {
  const { userId, waypointId, feedbackText, ciaContext } = req.body as {
    userId: string;
    waypointId: string;
    feedbackText: string;
    ciaContext?: { goals?: Array<{ goal_text?: string; description?: string; category?: string }>; deltas?: unknown[] };
  };

  if (!userId || !waypointId || !feedbackText) {
    res.status(400).json({ error: 'userId, waypointId, and feedbackText are required' });
    return;
  }

  try {
    // 1. Fetch the current waypoint
    const wp = await EducationWaypointModel.findById(waypointId).lean();
    if (!wp) {
      res.status(404).json({ error: 'Waypoint not found' });
      return;
    }

    // 2. Fetch other accepted waypoints for context
    const otherWaypoints = await EducationWaypointModel.find(
      { userId, status: 'accepted', _id: { $ne: waypointId } },
    )
      .sort({ position: 1 })
      .lean();

    // 2b. Compute year boundaries from neighboring waypoints
    const sorted = otherWaypoints
      .filter(w => w.projectedYear)
      .sort((a, b) => (a.projectedYear ?? 0) - (b.projectedYear ?? 0));
    const prevWp = sorted.filter(w => (w.projectedYear ?? 0) < (wp.projectedYear ?? 0)).pop();
    const nextWp = sorted.find(w => (w.projectedYear ?? 0) > (wp.projectedYear ?? 0));
    const currentYear = new Date().getFullYear();
    const minYear = prevWp ? (prevWp.projectedYear ?? currentYear) + 1 : currentYear + 1;
    const maxYear = nextWp ? (nextWp.projectedYear ?? 9999) - 1 : (wp.projectedYear ?? currentYear) + 5;
    const idealYear = wp.projectedYear ?? Math.round((minYear + maxYear) / 2);

    // 3. Build CIA goals text
    const goalsText = ciaContext?.goals?.map(g => `- ${g.goal_text || g.description || ''}`).join('\n') || 'No goals available';
    const otherWpText = otherWaypoints.map(w =>
      `- Position ${w.position}: ${w.credentialName} at ${w.institution} (${w.projectedYear}, $${w.tuitionMidpoint})`,
    ).join('\n') || 'No other waypoints';

    const prompt = `You are an Education Intelligence Agent. A user is reconsidering one step in their education pathway and has provided feedback about what they don't like.

CURRENT WAYPOINT (position ${wp.position}):
- Credential: ${wp.credentialName}
- Institution: ${wp.institution}
- Type: ${wp.credentialType}
- Year: ${wp.projectedYear}
- Tuition: $${wp.tuitionMidpoint}
- Delivery: ${wp.deliveryMode}
- Location: ${wp.location}

USER FEEDBACK:
"${feedbackText}"

FULL PATHWAY CONTEXT (other accepted waypoints):
${otherWpText}

PATHWAY NEIGHBORS:
- Previous waypoint: ${prevWp ? `${prevWp.credentialName} at ${prevWp.institution} (${prevWp.projectedYear})` : 'None (this is the first waypoint)'}
- Next waypoint: ${nextWp ? `${nextWp.credentialName} at ${nextWp.institution} (${nextWp.projectedYear})` : 'None (this is the last waypoint)'}
The replacement must fit logically between these two credentials.

YEAR CONSTRAINT (strict):
- projectedYear MUST be between ${minYear} and ${maxYear} inclusive.
- Aim for ${idealYear} if it fits that range.

CIA EDUCATION GOALS:
${goalsText}

Based on the user's feedback, suggest ONE better-fitting replacement education waypoint for position ${wp.position}. The replacement should:
- Address the user's stated concerns
- Maintain logical education progression
- Be a REAL, currently-available program

Respond with ONLY valid JSON (no markdown, no explanation):
{
  "credentialName": "...",
  "institution": "...",
  "credentialType": "degree|certification|bootcamp|course|other",
  "location": "City, ST or Remote",
  "deliveryMode": "online|in-person|hybrid|flexible",
  "projectedYear": ...,
  "durationMonths": ...,
  "tuitionMin": ...,
  "tuitionMax": ...,
  "salaryImpactPct": ...,
  "salaryRoiPerYear": ...,
  "rationale": "One sentence explaining why this is a better fit based on the feedback",
  "confidence": 0.85,
  "url": "https://...",
  "financialAid": true,
  "tags": ["tag1", "tag2"]
}`;

    const callPerplexityFn = async (p: string) => {
      const perplexityRes = await fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ENV.PERPLEXITY_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'sonar-pro',
          messages: [
            { role: 'system', content: 'You are an Education Intelligence Agent. Always respond with valid JSON only — no markdown, no explanation outside the JSON.' },
            { role: 'user', content: p },
          ],
          temperature: 0.2,
          max_tokens: 1500,
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!perplexityRes.ok) {
        const body = await perplexityRes.text();
        throw new Error(`Perplexity error ${perplexityRes.status}: ${body}`);
      }
      const data = await perplexityRes.json() as {
        choices: Array<{ message: { content: string } }>;
      };
      return data.choices[0]?.message?.content || '';
    };

    // 4. Call Perplexity and parse — retry once on parse failure
    let parsed: Record<string, unknown> | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const content = await callPerplexityFn(
        attempt === 0 ? prompt : prompt + '\n\nIMPORTANT: Your previous response was not valid JSON. Respond with ONLY a single JSON object, no markdown fences, no extra text.',
      );
      try {
        const cleaned = content.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
        parsed = JSON.parse(cleaned);
        break;
      } catch {
        log.warn({ attempt, contentPreview: content.slice(0, 200) }, 'Failed to parse regenerate-one response');
        if (attempt === 1) throw new Error('Failed to parse Perplexity response after retry');
      }
    }

    if (!parsed || !parsed.credentialName) {
      throw new Error('Invalid suggestion from Perplexity');
    }

    // 5. Build response
    const tuitionMin = Number(parsed.tuitionMin) || 0;
    const tuitionMax = Number(parsed.tuitionMax) || 0;
    const suggestion = {
      credentialName: String(parsed.credentialName),
      institution: String(parsed.institution || ''),
      credentialType: String(parsed.credentialType || 'course'),
      location: String(parsed.location || ''),
      deliveryMode: String(parsed.deliveryMode || 'online'),
      projectedYear: Number(parsed.projectedYear) || wp.projectedYear,
      durationMonths: Number(parsed.durationMonths) || 6,
      tuitionMin: Math.min(tuitionMin, tuitionMax),
      tuitionMax: Math.max(tuitionMin, tuitionMax),
      tuitionMidpoint: Math.round((tuitionMin + tuitionMax) / 2),
      salaryImpactPct: Number(parsed.salaryImpactPct) || 0,
      salaryRoiPerYear: Number(parsed.salaryRoiPerYear) || 0,
      rationale: String(parsed.rationale || ''),
      confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0.7)),
      url: typeof parsed.url === 'string' && (parsed.url as string).startsWith('http') ? String(parsed.url) : undefined,
      financialAid: Boolean(parsed.financialAid),
      tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
      position: wp.position,
    };

    log.info({ userId, waypointId, suggestion: suggestion.credentialName }, 'Regenerate-one suggestion generated');
    res.json({
      suggestion,
      currentWaypoint: { id: waypointId, credentialName: wp.credentialName, institution: wp.institution },
    });
  } catch (err) {
    log.error({ err, userId, waypointId }, 'Failed to generate waypoint suggestion');
    res.status(500).json({ error: 'Failed to generate suggestion' });
  }
});

// ── POST /api/agent/insert-waypoint ─────────────────────────────
router.post('/insert-waypoint', requireApiKey, async (req: Request, res: Response) => {
  const { userId, afterPosition, prevWaypoint, nextWaypoint, ciaGoals, allAcceptedWaypoints } = req.body as {
    userId: string;
    afterPosition: number;
    prevWaypoint: Record<string, unknown> | null;
    nextWaypoint: Record<string, unknown> | null;
    ciaGoals: Array<{ goal_id?: string; goal_text?: string; category?: string; status?: string }>;
    allAcceptedWaypoints: Array<Record<string, unknown>>;
  };

  if (!userId || afterPosition === undefined || afterPosition === null) {
    res.status(400).json({ error: 'userId and afterPosition are required' });
    return;
  }

  try {
    // 1. Build context strings for the prompt
    const prevFields = prevWaypoint
      ? `- credentialName: ${prevWaypoint.credentialName}
- institution: ${prevWaypoint.institution}
- credentialType: ${prevWaypoint.credentialType}
- projectedYear: ${prevWaypoint.projectedYear}
- tuitionMidpoint: $${prevWaypoint.tuitionMidpoint}
- deliveryMode: ${prevWaypoint.deliveryMode}
- location: ${prevWaypoint.location}
- rationale: ${prevWaypoint.rationale}`
      : 'None — this is the first waypoint';

    const nextFields = nextWaypoint
      ? `- credentialName: ${nextWaypoint.credentialName}
- institution: ${nextWaypoint.institution}
- credentialType: ${nextWaypoint.credentialType}
- projectedYear: ${nextWaypoint.projectedYear}
- tuitionMidpoint: $${nextWaypoint.tuitionMidpoint}
- deliveryMode: ${nextWaypoint.deliveryMode}
- location: ${nextWaypoint.location}
- rationale: ${nextWaypoint.rationale}`
      : 'None — this is the last waypoint';

    const pathwayText = (allAcceptedWaypoints || []).map((w: Record<string, unknown>) =>
      `- Position ${w.position}: ${w.credentialName} at ${w.institution} (${w.projectedYear}, $${w.tuitionMidpoint})`,
    ).join('\n') || 'No existing waypoints';

    const goalsText = (ciaGoals || []).map(g => `- [${g.category}] ${g.goal_text}`).join('\n') || 'No active goals';

    const prevYear = prevWaypoint ? Number(prevWaypoint.projectedYear) : new Date().getFullYear();
    const nextYear = nextWaypoint ? Number(nextWaypoint.projectedYear) : prevYear + 2;

    const prompt = `You are an Education Intelligence Agent generating ONE new education waypoint to insert into a user's education pathway.

PREVIOUS EDUCATION WAYPOINT (position ${afterPosition}):
${prevFields}

NEXT EDUCATION WAYPOINT (position ${afterPosition + 1}):
${nextFields}

FULL PATHWAY CONTEXT:
${pathwayText}

CIA HARD CONSTRAINTS (active goals — must honor):
${goalsText}

YEAR CONSTRAINT: The new waypoint's projectedYear MUST be strictly between ${prevYear} and ${nextYear}. If nextWaypoint is null, use ${prevYear + 2} as a reasonable target.

Generate ONE education credential that:
- Bridges the gap logically between these two waypoints
- Is a REAL, currently available program
- Matches the user's evident career direction
- Honors CIA goals as hard constraints
- Has a projectedYear strictly between the neighbors

Respond with ONLY valid JSON (no markdown, no explanation):
{
  "credentialName": "...",
  "institution": "...",
  "credentialType": "degree|certification|bootcamp|course|other",
  "location": "City, ST or Remote",
  "deliveryMode": "online|in-person|hybrid|flexible",
  "projectedYear": ...,
  "durationMonths": ...,
  "tuitionMin": ...,
  "tuitionMax": ...,
  "salaryImpactPct": ...,
  "salaryRoiPerYear": ...,
  "rationale": "One sentence explaining why this fits this gap",
  "confidence": 0.85,
  "url": "https://...",
  "financialAid": true,
  "tags": ["tag1", "tag2"]
}`;

    // 2. Call Perplexity sonar-pro (same pattern as regenerate-one)
    const callPerplexityFn = async (p: string) => {
      const perplexityRes = await fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ENV.PERPLEXITY_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'sonar-pro',
          messages: [
            { role: 'system', content: 'You are an Education Intelligence Agent. Always respond with valid JSON only — no markdown, no explanation outside the JSON.' },
            { role: 'user', content: p },
          ],
          temperature: 0.2,
          max_tokens: 1500,
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!perplexityRes.ok) {
        const body = await perplexityRes.text();
        throw new Error(`Perplexity error ${perplexityRes.status}: ${body}`);
      }
      const data = await perplexityRes.json() as {
        choices: Array<{ message: { content: string } }>;
      };
      return data.choices[0]?.message?.content || '';
    };

    // 3. Call and parse — retry once on JSON parse failure
    let parsed: Record<string, unknown> | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const content = await callPerplexityFn(
        attempt === 0 ? prompt : prompt + '\n\nIMPORTANT: Your previous response was not valid JSON. Respond with ONLY a single JSON object, no markdown fences, no extra text.',
      );
      try {
        const cleaned = content.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
        parsed = JSON.parse(cleaned);
        break;
      } catch {
        log.warn({ attempt, contentPreview: content.slice(0, 200) }, 'Failed to parse insert-waypoint response');
        if (attempt === 1) throw new Error('Failed to parse Perplexity response after retry');
      }
    }

    if (!parsed || !parsed.credentialName) {
      throw new Error('Invalid waypoint from Perplexity');
    }

    // 4. Compute tuition values
    const tuitionMin = Number(parsed.tuitionMin) || 0;
    const tuitionMax = Number(parsed.tuitionMax) || 0;
    const tuitionMidpoint = Math.round((Math.min(tuitionMin, tuitionMax) + Math.max(tuitionMin, tuitionMax)) / 2);

    // 5. Save new waypoint to MongoDB with fractional position
    const newWp = new EducationWaypointModel({
      userId,
      waypointId: uuidv4(),
      credentialName:  String(parsed.credentialName),
      institution:     String(parsed.institution || ''),
      credentialType:  String(parsed.credentialType || 'course'),
      location:        String(parsed.location || ''),
      deliveryMode:    String(parsed.deliveryMode || 'online'),
      projectedYear:   Number(parsed.projectedYear) || prevYear + 1,
      durationMonths:  Number(parsed.durationMonths) || 6,
      tuitionMin:      Math.min(tuitionMin, tuitionMax),
      tuitionMax:      Math.max(tuitionMin, tuitionMax),
      tuitionMidpoint,
      salaryImpactPct: Number(parsed.salaryImpactPct) || 0,
      salaryRoiPerYear: Number(parsed.salaryRoiPerYear) || 0,
      rationale:       String(parsed.rationale || ''),
      position:        afterPosition + 0.5,
      status:          'accepted',
      confidence:      Math.min(1, Math.max(0, Number(parsed.confidence) || 0.85)),
      url:             typeof parsed.url === 'string' && (parsed.url as string).startsWith('http') ? String(parsed.url) : undefined,
      financialAid:    Boolean(parsed.financialAid),
      tags:            Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
    });
    await newWp.save();

    log.info({ userId, afterPosition, waypointId: newWp.waypointId }, 'Insert-waypoint created');
    res.json({ success: true, waypoint: newWp.toObject() });
  } catch (err) {
    log.error({ err, userId, afterPosition }, 'Failed to insert waypoint');
    res.status(500).json({ error: 'Failed to insert waypoint' });
  }
});

// ── POST /api/agent/waypoints/replace-with-suggestion ──────────
router.post('/waypoints/replace-with-suggestion', requireApiKey, async (req: Request, res: Response) => {
  const { userId, waypointId, suggestion } = req.body as {
    userId: string;
    waypointId: string;
    suggestion: {
      credentialName: string; institution: string; credentialType: string;
      location: string; deliveryMode: string; projectedYear: number;
      durationMonths: number; tuitionMin: number; tuitionMax: number;
      tuitionMidpoint: number; salaryImpactPct: number; salaryRoiPerYear: number;
      rationale: string; confidence: number; url?: string;
      financialAid: boolean; tags: string[]; position: number;
    };
  };

  if (!userId || !waypointId || !suggestion?.credentialName) {
    res.status(400).json({ error: 'userId, waypointId, and suggestion are required' });
    return;
  }

  try {
    const existing = await EducationWaypointModel.findById(waypointId);
    if (!existing) {
      res.status(404).json({ error: 'Waypoint not found' });
      return;
    }

    // Server-side year clamp
    const allWps = await EducationWaypointModel.find(
      { userId, status: 'accepted', _id: { $ne: waypointId } },
      { projectedYear: 1, position: 1 },
    ).lean();
    const sortedWps = allWps.sort((a, b) => (a.projectedYear ?? 0) - (b.projectedYear ?? 0));
    const prevNeighbor = sortedWps.filter(w => (w.projectedYear ?? 0) < (existing.projectedYear ?? 0)).pop();
    const nextNeighbor = sortedWps.find(w => (w.projectedYear ?? 0) > (existing.projectedYear ?? 0));
    const curYear = new Date().getFullYear();
    const minYr = prevNeighbor ? (prevNeighbor.projectedYear ?? curYear) + 1 : curYear + 1;
    const maxYr = nextNeighbor ? (nextNeighbor.projectedYear ?? 9999) - 1 : (existing.projectedYear ?? curYear) + 5;
    suggestion.projectedYear = Math.max(minYr, Math.min(maxYr, suggestion.projectedYear ?? existing.projectedYear ?? minYr));

    const newWp = new EducationWaypointModel({
      userId,
      waypointId: uuidv4(),
      credentialName:  suggestion.credentialName,
      institution:     suggestion.institution || '',
      credentialType:  suggestion.credentialType || 'course',
      location:        suggestion.location || '',
      deliveryMode:    suggestion.deliveryMode || 'online',
      projectedYear:   suggestion.projectedYear,
      durationMonths:  suggestion.durationMonths || 6,
      tuitionMin:      suggestion.tuitionMin || 0,
      tuitionMax:      suggestion.tuitionMax || 0,
      tuitionMidpoint: suggestion.tuitionMidpoint || 0,
      salaryImpactPct: suggestion.salaryImpactPct || 0,
      salaryRoiPerYear: suggestion.salaryRoiPerYear || 0,
      rationale:       suggestion.rationale || '',
      position:        existing.position,
      status:          'accepted',
      confidence:      suggestion.confidence || 0.85,
      agentRunId:      existing.agentRunId,
      url:             suggestion.url,
      financialAid:    suggestion.financialAid || false,
      tags:            suggestion.tags || [],
    });
    await newWp.save();

    await EducationWaypointModel.findByIdAndUpdate(waypointId, {
      $set: { status: 'replaced', replacedById: String(newWp._id) },
    });

    postAuditEvent({
      userId,
      type: 'pathway_regenerated',
      subject: 'Education Pathway Updated',
      detail: `An education waypoint was replaced. Removed: ${existing.credentialName} at ${existing.institution} (${existing.projectedYear}, $${existing.tuitionMidpoint?.toLocaleString()}). Added: ${suggestion.credentialName} at ${suggestion.institution} (${suggestion.projectedYear}, $${suggestion.tuitionMidpoint?.toLocaleString()}).`,
      action: 'Education pathway updated.',
      source: 'eia',
      data: {
        removedWaypointId: waypointId,
        addedWaypointId: String(newWp._id),
        removed: { credentialName: existing.credentialName, institution: existing.institution, projectedYear: existing.projectedYear, tuitionMidpoint: existing.tuitionMidpoint },
        added: { credentialName: suggestion.credentialName, institution: suggestion.institution, projectedYear: suggestion.projectedYear, tuitionMidpoint: suggestion.tuitionMidpoint },
      },
    }).catch(() => {});

    log.info({ userId, waypointId, newWaypointId: String(newWp._id) }, 'Waypoint replaced with suggestion');
    res.json({ success: true, newWaypointId: String(newWp._id) });
  } catch (err) {
    log.error({ err, userId, waypointId }, 'Failed to replace waypoint with suggestion');
    res.status(500).json({ error: 'Failed to replace waypoint' });
  }
});

// ── GET /api/agent/education-matches/:userId ────────────────────
router.get('/education-matches/:userId', requireApiKey, async (req: Request, res: Response) => {
  const { userId } = req.params;
  const waypointId = (req.query.waypointId as string) || '';

  try {
    // 1. Get waypoints — when a specific waypointId is provided, find that waypoint regardless of
    //    status (user may click "Show potential providers" on a pending item). Otherwise top 3 accepted.
    let waypoints;
    if (waypointId) {
      // waypointId from frontend is always a UUID string — never a Mongo ObjectId.
      // Querying { _id: uuid } throws a Mongoose CastError. Query by waypointId field only.
      waypoints = await EducationWaypointModel.find(
        { userId, waypointId },
        { credentialName: 1, institution: 1, credentialType: 1, projectedYear: 1, position: 1,
          tuitionMin: 1, tuitionMax: 1, deliveryMode: 1, location: 1, rationale: 1, confidence: 1 },
      )
        .lean();
    } else {
      waypoints = await EducationWaypointModel.find(
        { userId, status: 'accepted' },
        { credentialName: 1, institution: 1, credentialType: 1, projectedYear: 1, position: 1,
          tuitionMin: 1, tuitionMax: 1, deliveryMode: 1, location: 1, rationale: 1, confidence: 1 },
      )
        .sort({ position: 1 })
        .limit(3)
        .lean();
    }

    const waypointSummaries = waypoints.map(w => ({
      credentialName: w.credentialName,
      institution:    w.institution,
      credentialType: w.credentialType,
      projectedYear:  w.projectedYear,
      position:       w.position,
      tuitionMin:     w.tuitionMin,
      tuitionMax:     w.tuitionMax,
      deliveryMode:   w.deliveryMode,
      location:       w.location,
      rationale:      w.rationale,
      confidence:     w.confidence,
    }));

    // 2. Get user profile from most recent completed agent run
    const lastRun = await AgentRunModel.findOne(
      { userId, status: 'completed' },
      { inputs: 1 },
    )
      .sort({ completedAt: -1 })
      .lean();

    const profile: UserProfile = lastRun?.inputs
      ? {
          userId,
          currentEducation: lastRun.inputs.currentEducation ?? undefined,
          location: lastRun.inputs.location ?? undefined,
        }
      : { userId };

    // 3. Fetch CIA context
    let ciaCtx: CIAContext = { goals: [], deltas: [] };
    try {
      const ciaRes = await fetch(
        `${ENV.CIA_BASE_URL}/api/v1/context/${userId}?module=education`,
        {
          headers: { 'Content-Type': 'application/json', 'x-api-key': ENV.INTERNAL_API_KEY },
          signal: AbortSignal.timeout(5000),
        },
      );
      if (ciaRes.ok) {
        const ciaData = await ciaRes.json() as CIAContext;
        ciaCtx = {
          goals: ciaData.goals || [],
          deltas: ciaData.deltas || [],
          career_summary: ciaData.career_summary ?? null,
        };
      }
    } catch {
      log.warn({ userId }, 'CIA context fetch failed for education matches — proceeding without');
    }

    // 4. Find matches
    const matches = await findEducationMatches(profile, ciaCtx, waypointSummaries);

    res.json({ userId, matches, generatedAt: new Date().toISOString() });
  } catch (err) {
    log.error({ err, userId }, 'Failed to find education matches');
    res.status(500).json({ error: 'Failed to find education matches', matches: [] });
  }
});

export default router;
