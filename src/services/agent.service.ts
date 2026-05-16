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

async function fetchExistingWaypoints(userId: string): Promise<{
  active: Array<Record<string, unknown>>;
  undesired: Array<Record<string, unknown>>;
}> {
  try {
    const waypoints = await EducationWaypointModel.find({ userId }).lean();
    const excludedStatuses = ['declined', 'replaced', 'undesired', 'deleted'];
    const active = waypoints.filter(w => !excludedStatuses.includes(String(w.status)));
    const undesired = waypoints.filter(w => w.status === 'undesired');
    return { active, undesired };
  } catch (err) {
    log.warn({ err, userId }, 'Failed to fetch existing waypoints');
    return { active: [], undesired: [] };
  }
}

async function fetchJobsData(userId: string): Promise<{ salary: number; geoDataSource: string | undefined }> {
  try {
    const res = await fetch(
      `${ENV.JOBS_BACKEND_URL}/api/jobs/user/${userId}`,
      {
        headers: { 'x-api-key': ENV.INTERNAL_API_KEY },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) throw new Error(`Jobs backend returned ${res.status}`);
    const data = await res.json() as Array<Record<string, unknown>>;
    const jobs = Array.isArray(data) ? data : [data];
    const currentJob = jobs.find(j => !j.endDate) || jobs[0];
    return {
      salary: Number(currentJob?.endingSalary || currentJob?.startingSalary || 0),
      geoDataSource: currentJob?.geoDataSource as string || undefined,
    };
  } catch (err) {
    log.warn({ err, userId }, 'Jobs data fetch failed — defaulting to 0/undefined');
    return { salary: 0, geoDataSource: undefined };
  }
}

async function fetchCurrentSalary(userId: string): Promise<number> {
  return (await fetchJobsData(userId)).salary;
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
  userCurrentSalary: number = 0,
  activeWaypoints: Array<Record<string, unknown>> = [],
  undesiredWaypoints: Array<Record<string, unknown>> = [],
  geoDataSource?: string,
): string {
  const market = geoDataSource || 'United States';
  const eduLines = educationHistory.length > 0
    ? educationHistory.map(e =>
        `- ${e.degree || e.credentialName || 'Unknown'} (${e.fieldOfStudy || 'General'}, ${e.yearCompleted || e.graduationYear || 'N/A'})`
      ).join('\n')
    : 'No formal education history recorded.';

  // Format career waypoints with enough detail for the EIA to reason about
  // which credentials unlock which job positions
  const careerLines = careerWaypoints.length > 0
    ? careerWaypoints.map((w: Record<string, unknown>) =>
        `- Position ${w.position}: ${w.jobTitle || w.title} at ${w.company || 'TBD'} (start: ${w.userStartDate || w.projectedYear || 'TBD'}, end: ${w.userEndDate || 'TBD'}, $${w.salaryMidpoint || 'N/A'})` +
        (w.sequenceRationale ? ` [Why this role: ${w.sequenceRationale}]` : '')
      ).join('\n')
    : 'No career waypoints mapped yet.';

  const goalsLines = ciaContext.goals.length > 0
    ? ciaContext.goals
        .filter(g => g.status === 'active')
        .map(g => `- [${g.category}] ${g.goal_text || g.description}`)
        .join('\n') || 'No active education goals.'
    : 'No education goals recorded.';

  // Item 3 — exclusion lists
  const activeWpLines = activeWaypoints.length > 0
    ? activeWaypoints.map(w => `- ${w.credentialName}`).join('\n')
    : 'None.';

  const undesiredWpLines = undesiredWaypoints.length > 0
    ? undesiredWaypoints.map(w =>
        `- ${w.credentialName} (type: ${w.credentialType || 'unknown'}, tuition: $${w.tuitionMin || 0}–$${w.tuitionMax || 0}, delivery: ${w.deliveryMode || 'unknown'})`
      ).join('\n')
    : 'None.';

  // Item 5 — unlocksJobPosition rule
  const unlocksRule = careerWaypoints.length > 0
    ? 'unlocksJobPosition is REQUIRED — every credential MUST have unlocksJobPosition set to a waypoint position number (1, 2, 3, etc.). Match the credential to the waypoint it most directly helps unlock. unlocksJobPosition may NOT be null.'
    : 'unlocksJobPosition: use null (no career waypoints mapped yet).';

  return `You are an Education Intelligence Agent. Analyze this user's background and generate a personalized, intelligently-sequenced education pathway.

## HARD CONSTRAINT — Research Market: ${market}
All credential recommendations, tuition ranges, provider availability, and market context MUST be relevant to the ${market} market. Do not use credentials or pricing from other countries. CIA goals and user notes may narrow by city or region within ${market} only.

CURRENT EDUCATION HISTORY:
${eduLines}

USER CURRENT SALARY: $${userCurrentSalary.toLocaleString()} per year

CAREER PATHWAY (job waypoints — what roles they're targeting):
${careerLines}

CIA EDUCATION GOALS:
${goalsLines}

ALREADY IN PATHWAY (do not suggest these exact credentials):
${activeWpLines}

USER REJECTION PATTERNS (credentials user marked as not a good fit):
${undesiredWpLines}

DOMAIN CONSTRAINT:
All credentials MUST be directly relevant to the user's career pathway roles listed above.
Do NOT suggest credentials from unrelated fields (e.g. software engineering, coding bootcamps, data science) unless the user's career waypoints explicitly require those skills.
The user's career domain is determined by their job titles and waypoint titles — stay within that domain.

## Your Task — Two-Phase Reasoning

PHASE 1 — Credential Type Decision (reason through this before picking credentials):
For each career waypoint above, determine:
1. What TYPE of credential is most impactful at this stage: degree (long-term, high-ROI for senior/exec roles), certification (fastest ROI, unlocks specific technical roles), bootcamp (practical skills, 3-6 months), or course (supplemental, low-cost)?
2. Which credential is a HARD REQUIREMENT to be considered for that role (priority 1) vs. strongly recommended (priority 2) vs. optional enhancement (priority 3)?
3. Is there a credential that must be completed BEFORE another one (prerequisite ordering)?

For example:
- If Position 1 requires a PMP or supply chain cert to stand out, that's priority=1 and unlocksJobPosition=1
- If a degree is needed only for Position 3+, schedule it to complete before Position 3's projectedYear
- Certs and short courses can often be done in parallel; degrees cannot

PHASE 2 — Generate 3-5 education waypoints based on Phase 1 reasoning.
Each waypoint is a credential ARCHETYPE — the TYPE of credential, not a specific program.

EXCLUSION RULES:
- Never suggest a credential already in the ALREADY IN PATHWAY list above.
- Analyze the USER REJECTION PATTERNS list for patterns (e.g. high tuition, online-only, wrong domain) and avoid repeating those patterns.
- If the rejection pattern is unclear, default to staying strictly within the user's career domain.

Return ONLY valid JSON array:
[{
  "credentialName": "Certified Supply Chain Professional (CSCP)",
  "institution": "",
  "credentialType": "certification",
  "location": "",
  "deliveryMode": "online",
  "projectedYear": 2027,
  "durationMonths": 6,
  "tuitionMin": 1500,
  "tuitionMax": 2500,
  "salaryImpactPct": 15,
  "attributionPct": 0.30,
  "salaryRoiPerYear": 0,
  "priority": 1,
  "unlocksJobPosition": 1,
  "sequenceRationale": "The CSCP is listed as preferred or required in 62% of Senior Supply Chain Manager job postings; completing it before applying for Position 1 (2028) increases interview conversion by ~2x.",
  "rationale": "",
  "confidence": 0.88,
  "url": "",
  "financialAid": false,
  "tags": ["Supply Chain", "Certification", "APICS"]
}]

FIELD RULES:
- credentialName: generic archetype like "Cloud Architecture Certification" or "Master of Science in Data Science" — never a branded product name
- institution: always empty string
- url: always empty string
- credentialType: one of: degree, certification, bootcamp, course, other
- deliveryMode: one of: online, in-person, hybrid, flexible
- priority: 1 = required to unlock next career waypoint, 2 = strongly recommended, 3 = optional enhancement
- ${unlocksRule}
- sequenceRationale: One sentence only. State concisely why this credential comes at this point in the career path.
- rationale: Always return an empty string "". Do not generate any rationale text.
- salaryImpactPct: estimated % salary increase from this credential based on real BLS/industry data for this field
- attributionPct: REQUIRED — decimal 0.0–1.0. This is the fraction of the salary gap between the user's current salary and the target waypoint salary that is attributable to this credential. NEVER omit this field. NEVER return 0 unless the credential has truly zero salary impact. Use these ranges STRICTLY by credential type: degree=0.50–0.70, certification=0.20–0.40, bootcamp=0.25–0.45, course=0.05–0.15. This is the primary driver of salaryRoiPerYear — take it seriously.
- salaryRoiPerYear: set to 0 — this will be computed in code from attributionPct
- tuitionMin/tuitionMax: typical market costs for this credential type
- projectedYear ordering: space out years to account for durationMonths. No overlap unless certs are truly self-paced and can run parallel.
- Logical prerequisite ordering: never place an advanced degree before the foundational cert that gates entry to the field
- Order waypoints by priority first (1s before 2s before 3s), then by projectedYear within each priority tier`;
}

// ── Parse Perplexity response ───────────────────────────────────

function parseWaypointResponse(
  content: string,
  careerWaypoints: Array<Record<string, unknown>> = [],
  userCurrentSalary: number = 0,
): RawEducationWaypoint[] {
  try {
    const cleaned = content.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    const parsed = JSON.parse(cleaned);
    const arr = Array.isArray(parsed) ? parsed : [parsed];

    return arr
      .filter((w: Record<string, unknown>) => w && w.credentialName)
      .map((w: Record<string, unknown>, i: number) => {
        const tuitionMin = Number(w.tuitionMin) || 0;
        const tuitionMax = Number(w.tuitionMax) || 0;
        const rawPriority = Number(w.priority);
        const priority = ([1, 2, 3].includes(rawPriority) ? rawPriority : null) as 1 | 2 | 3 | null;
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
          salaryRoiPerYear: (() => {
            const targetWp = careerWaypoints.find(cw => Number(cw.position) === Number(w.unlocksJobPosition))
              || careerWaypoints[0];
            const waypointSalaryMid = Number(targetWp?.salaryMidpoint || targetWp?.salaryMid || 0);
            const delta = waypointSalaryMid - userCurrentSalary;
            if (delta <= 0 || !targetWp) return 0;
            let attributionPct = Math.min(1, Math.max(0, Number(w.attributionPct) || 0));
            // Default attributionPct by credential type when LLM returns 0 or missing
            if (attributionPct === 0) {
              const credType = String(w.credentialType || 'unknown').toLowerCase();
              const defaults: Record<string, number> = {
                degree: 0.60,
                certification: 0.30,
                bootcamp: 0.35,
                course: 0.10,
              };
              attributionPct = defaults[credType] ?? 0.20;
            }
            return Math.round(delta * attributionPct);
          })(),
          rationale: String(w.rationale || ''),
          confidence: Math.min(1, Math.max(0, Number(w.confidence) || 0.7)),
          url: typeof w.url === 'string' && w.url.startsWith('http') ? w.url : undefined,
          financialAid: Boolean(w.financialAid),
          tags: Array.isArray(w.tags) ? w.tags.map(String) : [],
          position: i + 1,
          priority: priority ?? undefined,
          unlocksJobPosition: w.unlocksJobPosition != null ? Number(w.unlocksJobPosition) : undefined,
          sequenceRationale: typeof w.sequenceRationale === 'string' ? w.sequenceRationale : undefined,
        };
      });
  } catch (err) {
    log.warn({ err, contentPreview: content.slice(0, 200) }, 'Failed to parse Perplexity education response');
    return [];
  }
}

// ── Audit event helper ──────────────────────────────────────────


// ── Recalc ──────────────────────────────────────────────────────
// Recomputes salaryRoiPerYear on all accepted waypoints using fresh salary data.
// Never creates, deletes, or modifies pathway statuses.
export async function recalcEduProjections(userId: string): Promise<void> {
  const [currentSalary, careerWaypoints, acceptedWaypoints] = await Promise.all([
    fetchCurrentSalary(userId),
    fetchCareerWaypoints(userId),
    EducationWaypointModel.find({ userId, status: 'accepted' }).lean(),
  ]);

  for (const wp of acceptedWaypoints) {
    const targetWp = careerWaypoints.find((cw: Record<string, unknown>) => Number(cw.position) === Number(wp.unlocksJobPosition)) || careerWaypoints[0];
    const waypointSalaryMid = Number((targetWp as Record<string, unknown>)?.salaryMidpoint || (targetWp as Record<string, unknown>)?.salaryMid || 0);
    const delta = waypointSalaryMid - currentSalary;
    if (delta <= 0 || !targetWp) continue;
    const credType = String(wp.credentialType || 'unknown').toLowerCase();
    const defaults: Record<string, number> = { degree: 0.60, certification: 0.30, bootcamp: 0.35, course: 0.10 };
    const attributionPct = defaults[credType] ?? 0.20;
    const salaryRoiPerYear = Math.round(delta * attributionPct);
    await EducationWaypointModel.findByIdAndUpdate(wp._id, { $set: { salaryRoiPerYear } });
  }
}

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
  credentialTypes: string[] = [],
  lastAcceptedYear?: number,
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
    // 1. Fetch education history, career waypoints, CIA context, current salary, and existing waypoints in parallel
    const [educationHistory, careerWaypoints, ciaContext, jobsData, existingWaypoints] = await Promise.all([
      fetchEducationHistory(userId),
      fetchCareerWaypoints(userId),
      fetchCIAContext(userId),
      fetchJobsData(userId),
      fetchExistingWaypoints(userId),
    ]);
    const userCurrentSalary = jobsData.salary;
    const geoDataSource = jobsData.geoDataSource;

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
      const rejected = await EducationWaypointModel.findOne({ $or: [{ waypointId: replacingWaypointId }, { _id: replacingWaypointId }] }).catch(() => EducationWaypointModel.findOne({ waypointId: replacingWaypointId }));
      if (!rejected) {
        rawWaypoints = [];
      } else {
        const prompt = buildEducationPathwayPrompt(educationHistory, careerWaypoints, ciaContext, userCurrentSalary, existingWaypoints.active, existingWaypoints.undesired, geoDataSource) +
          `\n\nIMPORTANT: The user rejected "${rejected.credentialName}". ` +
          `Generate exactly 1 replacement credential for position ${rejected.position} that is meaningfully different. ` +
          `The replacement MUST use projectedYear = ${rejected.projectedYear} (do NOT change the year — the user assigned this slot). ` +
          `Return a JSON array with exactly 1 element.`;

        let content = '';
        for (let attempt = 0; attempt < 2; attempt++) {
          content = await callPerplexity(
            attempt === 0 ? prompt : prompt + '\n\nIMPORTANT: Your previous response was not valid JSON. Respond with ONLY a JSON array.',
          );
          const parsed = parseWaypointResponse(content);
          if (parsed.length > 0) {
            // Always lock to the declined waypoint's projectedYear — never let Perplexity reassign it
            rawWaypoints = [{ ...parsed[0], position: rejected.position, projectedYear: rejected.projectedYear }];
            break;
          }
        }
        rawWaypoints = rawWaypoints! || [];
      }
    } else if (trigger === 'add_new') {
      // Add New — fetch already-accepted waypoints and suggest NEW/DIFFERENT ones
      // Clean existing waypoints before fresh run (prevents duplicate accumulation)
      await EducationWaypointModel.deleteMany({ userId });

      const acceptedWaypoints = await EducationWaypointModel.find({ userId, status: 'accepted' }).lean();
      const acceptedLines = acceptedWaypoints.length > 0
        ? acceptedWaypoints.map(w => `- ${w.credentialName} (${w.credentialType}, ~${w.projectedYear})`).join('\n')
        : 'None yet.';

      const basePrompt = buildEducationPathwayPrompt(educationHistory, careerWaypoints, ciaContext, userCurrentSalary, existingWaypoints.active, existingWaypoints.undesired, geoDataSource);
      const addNewPrompt = basePrompt +
        `\n\nUSER'S ALREADY ACCEPTED CREDENTIALS:\n${acceptedLines}\n\n` +
        `IMPORTANT: The user wants NEW education ideas. Do NOT suggest anything similar to the already-accepted credentials above. ` +
        `You MUST suggest exactly 3 DIFFERENT credential archetypes that complement but do not duplicate the existing pathway. Your JSON array MUST contain exactly 3 objects. Do NOT return fewer than 3. ` +
        `Focus on adjacent skills, emerging areas, or credential types not yet covered. ` +
        (credentialTypes.length > 0
          ? `The user specifically wants suggestions of the following credential type(s): ${credentialTypes.join(', ')}. Only suggest credentials of these types. `
          : '') +
        (lastAcceptedYear
          ? `\nAll new waypoints MUST have projectedYear strictly greater than ${lastAcceptedYear}. Start the first new waypoint at ${lastAcceptedYear + 1} or later.\n`
          : '') +
        `Return ONLY a valid JSON array.`;

      rawWaypoints = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        const content = await callPerplexity(
          attempt === 0 ? addNewPrompt : addNewPrompt + '\n\nCRITICAL: Return EXACTLY 3 waypoint objects in your JSON array. Not 1, not 2 — exactly 3.\n\nIMPORTANT: Your previous response was not valid JSON. Respond with ONLY a valid JSON array.',
        );
        rawWaypoints = parseWaypointResponse(content, careerWaypoints, userCurrentSalary);
        if (rawWaypoints.length > 0) break;
        log.warn({ attempt }, 'Failed to parse add_new response — retrying');
      }
    } else {
      // Full run — clean existing waypoints to prevent duplicate accumulation
      await EducationWaypointModel.deleteMany({ userId });

      // Full run — generate 3-5 waypoints
      let content = '';
      rawWaypoints = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        const prompt = buildEducationPathwayPrompt(educationHistory, careerWaypoints, ciaContext, userCurrentSalary, existingWaypoints.active, existingWaypoints.undesired, geoDataSource);
        content = await callPerplexity(
          attempt === 0 ? prompt : prompt + '\n\nIMPORTANT: Your previous response was not valid JSON. Respond with ONLY a valid JSON array.',
        );
        rawWaypoints = parseWaypointResponse(content, careerWaypoints, userCurrentSalary);
        if (rawWaypoints.length > 0) break;
        log.warn({ attempt, contentPreview: content.slice(0, 200) }, 'Failed to parse pathway response — retrying');
      }
    }

    run.perplexityCallCount = 1;

    // 3a. Assign MM/YYYY suggested dates using durationMonths cursor (priority-ordered)
    //     Only fills in dates not already set by the user.
    const _addMonths = (y: number, m: number, n: number) => {
      const total = (m - 1) + n;
      return { year: y + Math.floor(total / 12), month: (total % 12) + 1 };
    };
    const _fmt = (y: number, m: number) => `${String(m).padStart(2, '0')}/${y}`;
    const _nowYear = new Date().getFullYear();
    const _nowMonth = new Date().getMonth() + 1;
    let _cursor = { year: _nowYear, month: _nowMonth };
    for (const raw of rawWaypoints) {
      const durMo = Math.max(6, raw.durationMonths ?? 12);
      if (!raw.userStartDate) raw.userStartDate = _fmt(_cursor.year, _cursor.month);
      const _end = _addMonths(_cursor.year, _cursor.month, durMo);
      if (!raw.userEndDate) raw.userEndDate = _fmt(_end.year, _end.month);
      _cursor = _addMonths(_end.year, _end.month, 1);
    }

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
        priority:           raw.priority ?? null,
        unlocksJobPosition: raw.unlocksJobPosition ?? null,
        sequenceRationale:  raw.sequenceRationale ?? null,
        userStartDate:      raw.userStartDate ?? null,
        userEndDate:        raw.userEndDate ?? null,
      });
      savedIds.push(String(wp._id));
    }

    // 4. Mark replaced waypoint if this is a replacement run
    if (replacingWaypointId && savedIds.length > 0) {
      await EducationWaypointModel.findOneAndUpdate(
        { $or: [{ waypointId: replacingWaypointId }, { _id: replacingWaypointId }] },
        { $set: { status: 'replaced', replacedById: savedIds[0] } },
      ).catch(() => EducationWaypointModel.findOneAndUpdate({ waypointId: replacingWaypointId }, { $set: { status: 'replaced', replacedById: savedIds[0] } }));
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
        const rejected = await EducationWaypointModel.findOne({ $or: [{ waypointId: replacingWaypointId }, { _id: replacingWaypointId }] }).lean().catch(() => EducationWaypointModel.findOne({ waypointId: replacingWaypointId }).lean());
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
