/**
 * Agent Service — orchestrates a full Education Intelligence Agent run.
 *
 * Sequence:
 * 1. Create an AgentRun record (status: running)
 * 2. Fetch user's education history from enPathEdu MongoDB (educationitems collection)
 * 3. Fetch career waypoints from enPathJobsBE (job waypoints — career goals)
 * 4. Fetch CIA context for the user (goals filtered for education intent)
 * 5. Call Perplexity (sonar-pro) to generate education pathway
 * 6. Save EducationWaypoint documents
 * 7. Update AgentRun as completed
 * 8. Post audit event + notifications
 */

import { v4 as uuidv4 } from 'uuid';
import { ENV } from '../config/env';
import { createLogger } from '../config/logger';
import { mongoose } from '../config/database';
import { AgentRunModel } from '../models/agentRun.model';
import { EducationWaypointModel } from '../models/educationWaypoint.model';
import type { AgentRunTrigger, CIAContext, RawEducationWaypoint } from '../types';

const log = createLogger('agent-service');

// ── GCP identity token (Cloud Run service-to-service auth) ──────

async function getGCPIdentityToken(audience: string): Promise<string | null> {
  try {
    const res = await fetch(
      `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}`,
      { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(2000) },
    );
    if (!res.ok) return null;
    return res.text();
  } catch {
    return null; // not running on GCP (local dev) — skip
  }
}

// ── Fetch helpers ────────────────────────────────────────────────

async function fetchEducationHistory(userId: string): Promise<Array<Record<string, unknown>>> {
  try {
    const db = mongoose.connection.db;
    if (!db) return [];
    const collection = db.collection('educationitems');
    const items = await collection.find({ userId }).sort({ createdAt: -1 }).toArray();
    return items as Array<Record<string, unknown>>;
  } catch (err) {
    log.warn({ err, userId }, 'Failed to fetch education history from MongoDB');
    return [];
  }
}

async function fetchCareerWaypoints(userId: string): Promise<Array<Record<string, unknown>>> {
  try {
    const res = await fetch(
      `${ENV.JOBS_BACKEND_URL}/api/jobs/waypoints/${userId}`,
      {
        headers: { 'x-api-key': ENV.INTERNAL_API_KEY },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) throw new Error(`Jobs backend returned ${res.status}`);
    const data = await res.json() as { waypoints?: Array<Record<string, unknown>> };
    return data.waypoints || [];
  } catch (err) {
    log.warn({ err, userId }, 'Career waypoints fetch failed — proceeding without');
    return [];
  }
}

async function fetchCIAContext(userId: string): Promise<CIAContext> {
  try {
    const res = await fetch(
      `${ENV.CIA_BASE_URL}/api/v1/context/${userId}?module=education`,
      {
        headers: { 'Content-Type': 'application/json', 'x-api-key': ENV.INTERNAL_API_KEY },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) throw new Error(`CIA returned ${res.status}`);
    const data = await res.json() as CIAContext;
    return {
      goals: data.goals || [],
      deltas: data.deltas || [],
      career_summary: data.career_summary ?? null,
    };
  } catch (err) {
    log.warn({ err, userId }, 'CIA context fetch failed — proceeding with empty context');
    return { goals: [], deltas: [] };
  }
}

// ── Perplexity caller ───────────────────────────────────────────

async function callPerplexity(prompt: string): Promise<string> {
  const res = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ENV.PERPLEXITY_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'sonar-pro',
      messages: [
        {
          role: 'system',
          content:
            'You are an Education Intelligence Agent. You generate personalized education pathway archetypes — ' +
            'generic credential types, NOT specific programs at specific institutions. ' +
            'Always respond with valid JSON only — no markdown, no explanation outside the JSON.',
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 2000,
    }),
    signal: AbortSignal.timeout(60000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Perplexity error ${res.status}: ${body}`);
  }

  const data = await res.json() as {
    choices: Array<{ message: { content: string } }>;
  };
  return data.choices[0]?.message?.content || '';
}

// ── Prompt builder ──────────────────────────────────────────────

function buildEducationPathwayPrompt(
  educationHistory: Array<Record<string, unknown>>,
  careerWaypoints: Array<Record<string, unknown>>,
  ciaContext: CIAContext,
): string {
  const eduLines = educationHistory.length > 0
    ? educationHistory.map(e =>
        `- ${e.degree || e.credentialName || 'Unknown'} (${e.fieldOfStudy || 'General'}, ${e.yearCompleted || e.graduationYear || 'N/A'})`
      ).join('\n')
    : 'No formal education history recorded.';

  const careerLines = careerWaypoints.length > 0
    ? careerWaypoints.map((w: Record<string, unknown>) =>
        `- Position ${w.position}: ${w.jobTitle || w.title} at ${w.company || 'TBD'} (${w.projectedYear}, $${w.salaryMidpoint || 'N/A'})`
      ).join('\n')
    : 'No career waypoints mapped yet.';

  const goalsLines = ciaContext.goals.length > 0
    ? ciaContext.goals
        .filter(g => g.status === 'active')
        .map(g => `- [${g.category}] ${g.goal_text || g.description}`)
        .join('\n') || 'No active education goals.'
    : 'No education goals recorded.';

  return `You are an Education Intelligence Agent. Analyze this user's background and generate a personalized education pathway.

CURRENT EDUCATION HISTORY:
${eduLines}

CAREER PATHWAY (job waypoints — what roles they're targeting):
${careerLines}

CIA EDUCATION GOALS:
${goalsLines}

Generate 3-5 education waypoints that bridge from their current education to their career goals.
Each waypoint is a credential ARCHETYPE — the TYPE of credential, not a specific program. Return ONLY valid JSON array:
[{
  "credentialName": "Master of Science in Data Analytics",
  "institution": "",
  "credentialType": "degree",
  "location": "",
  "deliveryMode": "online",
  "projectedYear": 2027,
  "durationMonths": 24,
  "tuitionMin": 7000,
  "tuitionMax": 10000,
  "salaryImpactPct": 85,
  "salaryRoiPerYear": 18000,
  "rationale": "One sentence why this fits the user's career trajectory",
  "confidence": 0.85,
  "url": "",
  "financialAid": true,
  "tags": ["Data Analytics", "Online", "STEM"]
}]

IMPORTANT RULES:
- Do NOT include any specific institution, provider, school, or company name. Waypoints describe the TYPE of credential the user should pursue, not where to get it.
- credentialName should be a generic archetype like "Cloud Architecture Certification", "Master of Science in Data Science", "Full-Stack Web Development Bootcamp" — never a branded name like "AWS SAA-C03" or "Georgia Tech OMSA"
- institution must always be an empty string
- url must always be an empty string
- credentialType must be one of: degree, certification, bootcamp, course, other
- deliveryMode must be one of: online, in-person, hybrid, flexible
- salaryImpactPct is the estimated % salary increase after completing this credential
- salaryRoiPerYear is the estimated annual additional earnings from this credential
- tuitionMin/tuitionMax should reflect typical market costs for this type of credential
- Space projectedYear values to account for duration. If a waypoint has durationMonths=24, the next waypoint's projectedYear must be at least 2 years after this one's projectedYear. Stack sequentially — no two waypoints should start in the same year unless one completes before the other begins.
- Order waypoints chronologically by projected completion year
- Ensure logical progression — don't suggest an advanced degree before prerequisites`;
}

// ── Parse Perplexity response ───────────────────────────────────

function parseWaypointResponse(content: string): RawEducationWaypoint[] {
  try {
    const cleaned = content.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    const parsed = JSON.parse(cleaned);
    const arr = Array.isArray(parsed) ? parsed : [parsed];

    return arr
      .filter((w: Record<string, unknown>) => w && w.credentialName)
      .map((w: Record<string, unknown>, i: number) => {
        const tuitionMin = Number(w.tuitionMin) || 0;
        const tuitionMax = Number(w.tuitionMax) || 0;
        return {
          credentialName: String(w.credentialName),
          institution: String(w.institution),
          credentialType: (['degree','certification','bootcamp','course','other'].includes(String(w.credentialType))
            ? String(w.credentialType)
            : 'course') as RawEducationWaypoint['credentialType'],
          location: String(w.location || 'Remote'),
          deliveryMode: (['online','in-person','hybrid','flexible'].includes(String(w.deliveryMode))
            ? String(w.deliveryMode)
            : 'online') as RawEducationWaypoint['deliveryMode'],
          projectedYear: Number(w.projectedYear) || new Date().getFullYear() + 1 + i,
          durationMonths: Number(w.durationMonths) || 6,
          tuitionMin: Math.min(tuitionMin, tuitionMax),
          tuitionMax: Math.max(tuitionMin, tuitionMax),
          salaryImpactPct: Number(w.salaryImpactPct) || 0,
          salaryRoiPerYear: Number(w.salaryRoiPerYear) || 0,
          rationale: String(w.rationale || ''),
          confidence: Math.min(1, Math.max(0, Number(w.confidence) || 0.7)),
          url: typeof w.url === 'string' && w.url.startsWith('http') ? w.url : undefined,
          financialAid: Boolean(w.financialAid),
          tags: Array.isArray(w.tags) ? w.tags.map(String) : [],
          position: i + 1,
        };
      });
  } catch (err) {
    log.warn({ err, contentPreview: content.slice(0, 200) }, 'Failed to parse Perplexity education response');
    return [];
  }
}

// ── Audit event helper ──────────────────────────────────────────

export async function postAuditEvent(payload: {
  userId: string;
  type: string;
  subject: string;
  detail: string;
  action?: string;
  source: string;
  data?: Record<string, unknown>;
}): Promise<void> {
  try {
    await fetch(`${ENV.BACKEND_BASE_URL}/api/activity`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ENV.INTERNAL_API_KEY,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    console.error('[audit] failed to post event:', e);
  }
}

// ── CIA notification ────────────────────────────────────────────

async function postCIANotification(userId: string, waypointCount: number): Promise<void> {
  try {
    const identityToken = await getGCPIdentityToken(ENV.CIA_BASE_URL);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': ENV.INTERNAL_API_KEY,
    };
    if (identityToken) {
      headers['Authorization'] = `Bearer ${identityToken}`;
    }
    await fetch(`${ENV.CIA_BASE_URL}/api/v1/notifications`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        userId,
        module: 'education',
        trigger: 'recommendation',
        title: 'Education Pathway Updated',
        message: `Your Education Agent has mapped ${waypointCount} education waypoints on your timeline based on your career goals and available programs.`,
        prefill: 'Can you walk me through my new education pathway?',
      }),
    });
  } catch (err) {
    log.warn({ err }, 'CIA notification post failed — non-critical');
  }
}

// ── Backend notifications ───────────────────────────────────────

async function postBackendNotifications(
  userId: string,
  runId: string,
  waypointCount: number,
  trigger: AgentRunTrigger,
  replacingWaypointId?: string,
): Promise<void> {
  const url = `${ENV.BACKEND_BASE_URL}/api/notifications`;
  const headers = { 'Content-Type': 'application/json', 'x-api-key': ENV.INTERNAL_API_KEY };

  const notifications: Array<{ type: string; title: string; message: string; prefill: string; meta: Record<string, unknown> }> = [];

  notifications.push({
    type: 'pathway_mapped',
    title: 'Education Pathway Updated',
    message: `Your Education Agent mapped ${waypointCount} education waypoints on your timeline based on your goals and available programs.`,
    prefill: 'Can you walk me through my updated education pathway and what programs were found?',
    meta: { agentRunId: runId, waypointCount },
  });

  if (replacingWaypointId) {
    notifications.push({
      type: 'waypoint_ready',
      title: 'New Education Option Ready',
      message: 'Your Education Agent found a replacement education option for your pathway.',
      prefill: 'Tell me about the new education option you found for my pathway.',
      meta: { agentRunId: runId, replacingWaypointId },
    });
  }

  for (const notif of notifications) {
    try {
      await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ userId, ...notif }),
      });
    } catch (err) {
      log.warn({ err, type: notif.type }, 'Backend notification post failed — non-critical');
    }
  }
}

// ── Main run ─────────────────────────────────────────────────────

export async function runAgentForUser(
  userId: string,
  trigger: AgentRunTrigger = 'manual',
  replacingWaypointId?: string,
): Promise<{ runId: string; waypointCount: number }> {
  const startedAt = new Date();

  // Create run record
  const run = await AgentRunModel.create({
    userId,
    trigger,
    status: 'running',
    inputs: { ciaGoals: [], ciaDeltas: [] },
    waypointIds: [],
    perplexityCallCount: 0,
    startedAt,
  });

  const runId = String(run._id);
  log.info({ runId, userId, trigger }, 'Agent run started');

  try {
    // 1. Fetch education history, career waypoints, and CIA context in parallel
    const [educationHistory, careerWaypoints, ciaContext] = await Promise.all([
      fetchEducationHistory(userId),
      fetchCareerWaypoints(userId),
      fetchCIAContext(userId),
    ]);

    // Update run inputs
    const latestEdu = educationHistory[0];
    run.inputs = {
      ciaGoals: ciaContext.goals.map(g => ({ category: g.category, description: g.description })),
      ciaDeltas: ciaContext.deltas.map(d => ({ label: d.label, direction: d.direction, change: d.change })),
      currentEducation: latestEdu ? String(latestEdu.degree || latestEdu.credentialName || '') : null,
      location: latestEdu ? String(latestEdu.location || '') : null,
      replacingWaypointId: replacingWaypointId,
    };
    await run.save();

    // 2. Generate education waypoints
    let rawWaypoints: RawEducationWaypoint[];

    if (replacingWaypointId) {
      // Single replacement — find rejected waypoint and generate alternative
      const rejected = await EducationWaypointModel.findById(replacingWaypointId);
      if (!rejected) {
        rawWaypoints = [];
      } else {
        const prompt = buildEducationPathwayPrompt(educationHistory, careerWaypoints, ciaContext) +
          `\n\nIMPORTANT: The user rejected "${rejected.credentialName}". ` +
          `Generate exactly 1 replacement credential for position ${rejected.position} that is meaningfully different. ` +
          `Return a JSON array with exactly 1 element.`;

        let content = '';
        for (let attempt = 0; attempt < 2; attempt++) {
          content = await callPerplexity(
            attempt === 0 ? prompt : prompt + '\n\nIMPORTANT: Your previous response was not valid JSON. Respond with ONLY a JSON array.',
          );
          const parsed = parseWaypointResponse(content);
          if (parsed.length > 0) {
            rawWaypoints = [{ ...parsed[0], position: rejected.position }];
            break;
          }
        }
        rawWaypoints = rawWaypoints! || [];
      }
    } else if (trigger === 'add_new') {
      // Add New — fetch already-accepted waypoints and suggest NEW/DIFFERENT ones
      const acceptedWaypoints = await EducationWaypointModel.find({ userId, status: 'accepted' }).lean();
      const acceptedLines = acceptedWaypoints.length > 0
        ? acceptedWaypoints.map(w => `- ${w.credentialName} (${w.credentialType}, ~${w.projectedYear})`).join('\n')
        : 'None yet.';

      const basePrompt = buildEducationPathwayPrompt(educationHistory, careerWaypoints, ciaContext);
      const addNewPrompt = basePrompt +
        `\n\nUSER'S ALREADY ACCEPTED CREDENTIALS:\n${acceptedLines}\n\n` +
        `IMPORTANT: The user wants NEW education ideas. Do NOT suggest anything similar to the already-accepted credentials above. ` +
        `Suggest 2-3 DIFFERENT credential archetypes that complement but do not duplicate the existing pathway. ` +
        `Focus on adjacent skills, emerging areas, or credential types not yet covered. ` +
        `Return ONLY a valid JSON array.`;

      rawWaypoints = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        const content = await callPerplexity(
          attempt === 0 ? addNewPrompt : addNewPrompt + '\n\nIMPORTANT: Your previous response was not valid JSON. Respond with ONLY a valid JSON array.',
        );
        rawWaypoints = parseWaypointResponse(content);
        if (rawWaypoints.length > 0) break;
        log.warn({ attempt }, 'Failed to parse add_new response — retrying');
      }
    } else {
      // Full run — generate 3-5 waypoints
      let content = '';
      rawWaypoints = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        const prompt = buildEducationPathwayPrompt(educationHistory, careerWaypoints, ciaContext);
        content = await callPerplexity(
          attempt === 0 ? prompt : prompt + '\n\nIMPORTANT: Your previous response was not valid JSON. Respond with ONLY a valid JSON array.',
        );
        rawWaypoints = parseWaypointResponse(content);
        if (rawWaypoints.length > 0) break;
        log.warn({ attempt, contentPreview: content.slice(0, 200) }, 'Failed to parse pathway response — retrying');
      }
    }

    run.perplexityCallCount = 1;

    // 3. Save waypoints to MongoDB
    const savedIds: string[] = [];
    for (const raw of rawWaypoints) {
      const tuitionMidpoint = Math.round((raw.tuitionMin + raw.tuitionMax) / 2);
      const wp = await EducationWaypointModel.create({
        userId,
        waypointId: uuidv4(),
        credentialName: raw.credentialName,
        institution: raw.institution,
        credentialType: raw.credentialType,
        location: raw.location,
        deliveryMode: raw.deliveryMode,
        projectedYear: raw.projectedYear,
        durationMonths: raw.durationMonths,
        tuitionMin: raw.tuitionMin,
        tuitionMax: raw.tuitionMax,
        tuitionMidpoint,
        salaryImpactPct: raw.salaryImpactPct,
        salaryRoiPerYear: raw.salaryRoiPerYear,
        rationale: raw.rationale,
        position: raw.position,
        status: 'pending',
        agentRunId: runId,
        confidence: raw.confidence,
        url: raw.url,
        financialAid: raw.financialAid,
        tags: raw.tags,
      });
      savedIds.push(String(wp._id));
    }

    // 4. Mark replaced waypoint if this is a replacement run
    if (replacingWaypointId && savedIds.length > 0) {
      await EducationWaypointModel.findByIdAndUpdate(replacingWaypointId, {
        $set: { status: 'replaced', replacedById: savedIds[0] },
      });
    }

    // 5. Complete the run record
    const completedAt = new Date();
    run.status = 'completed';
    run.waypointIds = savedIds;
    run.completedAt = completedAt;
    run.durationMs = completedAt.getTime() - startedAt.getTime();
    await run.save();

    // 6. Notify CIA + Backend (fire-and-forget)
    if (savedIds.length > 0) {
      postCIANotification(userId, savedIds.length).catch(() => {});
      postBackendNotifications(userId, runId, savedIds.length, trigger, replacingWaypointId).catch(() => {});
    }

    // 7. Audit events (fire-and-forget)
    if (savedIds.length > 0) {
      if (replacingWaypointId) {
        const rejected = await EducationWaypointModel.findById(replacingWaypointId).lean();
        const newWp = rawWaypoints[0];
        postAuditEvent({
          userId,
          type: 'pathway_regenerated',
          subject: 'Education Pathway Updated',
          detail: `An education waypoint was replaced. Removed: ${rejected?.credentialName || 'Unknown'}. Added: ${newWp?.credentialName || 'Unknown'}.`,
          action: 'Education pathway updated.',
          source: 'eia',
          data: {
            removedWaypointId: replacingWaypointId,
            addedWaypointId: savedIds[0],
          },
        }).catch(() => {});
      } else {
        postAuditEvent({
          userId,
          type: 'pathway_generated',
          subject: 'Education Pathway',
          detail: `Your education pathway was generated with ${rawWaypoints.length} steps. Programs include: ${rawWaypoints.map(w => w.credentialName).join(', ')}.`,
          action: 'Education pathway is now visible on your dashboard.',
          source: 'eia',
        }).catch(() => {});
      }
    }

    log.info({ runId, userId, waypointCount: savedIds.length }, 'Agent run completed');
    return { runId, waypointCount: savedIds.length };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.error({ err, runId, userId }, 'Agent run failed');
    run.status = 'failed';
    run.errorMessage = errorMessage;
    run.completedAt = new Date();
    run.durationMs = Date.now() - startedAt.getTime();
    await run.save();
    throw err;
  }
}
