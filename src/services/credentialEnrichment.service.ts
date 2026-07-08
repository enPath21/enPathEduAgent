// ─── Credential Enrichment Service ──────────────────────────────────────────
// Computes financial fields for an arbitrary credential (used for both future
// archetypes and historical education items). Given a credential's basic
// metadata (name, institution, type, dates, location) plus the user's job
// context, calls Perplexity sonar to estimate:
//   - durationMonths (how long the credential takes to complete)
//   - tuitionMin / tuitionMax / tuitionMidpoint (market cost)
//   - salaryImpactPct (percent salary lift attributable to this credential)
//   - salaryRoiPerYear (dollars/year using the same computeRoi() logic as archetypes)
//
// Wired into POST /api/agent/enrich-credential (see agent.routes.ts).
// Used by Edu BE on history create / update to enrich EducationItem records.

import { ENV } from '../config/env';
import { createLogger } from '../config/logger';

const log = createLogger('credentialEnrichment');

export interface EnrichmentInput {
  credentialName: string;
  institution?: string;
  credentialType?: string;      // degree | certification | bootcamp | course | other
  startDate?: string | null;    // ISO or null
  endDate?: string | null;      // ISO or null (completion year is derived from endDate)
  location?: string;
  deliveryMode?: string;
  isHistorical?: boolean;       // true = already completed, false/undefined = future archetype
}

export interface EnrichmentResult {
  durationMonths: number;
  tuitionMin: number;
  tuitionMax: number;
  tuitionMidpoint: number;
  salaryImpactPct: number;
  salaryRoiPerYear: number;
  confidence: number;
}

export interface UserContext {
  market: string;              // geo, e.g. "United States"
  currentJobTitle: string;
  currentSalary: number;
  careerWaypoints: Array<Record<string, unknown>>;  // for computeRoi() anchor
}

// ─── computeRoi ──────────────────────────────────────────────────────────────
// Mirrors the inline computeRoi() in insert-waypoint (agent.routes.ts line 475).
// Kept as a standalone helper here so history enrichment uses the identical
// formula archetypes use. Do not diverge without also updating the inline copy.
export function computeCredentialRoi(
  credentialType: string,
  attributionPct: number,
  unlocksPos: number | null,
  salaryImpactPct: number,
  ctx: UserContext,
): number {
  const userSalary = Number(ctx.currentSalary || 0);
  let pct = Math.min(1, Math.max(0, attributionPct));
  if (pct === 0) {
    const defaults: Record<string, number> = {
      degree: 0.60, certification: 0.30, bootcamp: 0.35, course: 0.10,
    };
    pct = defaults[credentialType.toLowerCase()] ?? 0.20;
  }
  const targetWp = unlocksPos != null
    ? ctx.careerWaypoints.find(w => Number(w.position) === unlocksPos) || ctx.careerWaypoints[0]
    : ctx.careerWaypoints[0];
  const waypointSalaryMid = Number((targetWp as Record<string, unknown>)?.salaryMidpoint || 0);
  const delta = waypointSalaryMid - userSalary;
  if (targetWp && delta > 0) {
    return Math.round(delta * pct);
  }
  const impactFraction = Math.min(1, Math.max(0, Number(salaryImpactPct) || 0)) / 100;
  return userSalary > 0 ? Math.round(userSalary * impactFraction * pct) : 0;
}

// ─── enrichCredential ────────────────────────────────────────────────────────
// Calls Perplexity sonar to estimate financial fields for a credential.
// Historical items (isHistorical=true) get a completion-year-aware prompt so
// tuition estimates reflect the market at time of completion.
// 30s timeout; retry once on JSON parse failure.
export async function enrichCredential(
  input: EnrichmentInput,
  ctx: UserContext,
): Promise<EnrichmentResult> {
  const {
    credentialName,
    institution = '',
    credentialType = 'course',
    endDate,
    location = '',
    deliveryMode = '',
    isHistorical = false,
  } = input;

  const completionYear = endDate ? new Date(endDate).getFullYear() : null;
  const currentYear = new Date().getFullYear();
  const yearContext = isHistorical && completionYear
    ? `This credential was completed in ${completionYear}. Estimate typical tuition ranges and salary impact **at time of completion** in the ${ctx.market} market — reflect market conditions of that year, not today.`
    : `This is a future/planned credential. Estimate typical current-market tuition ranges and salary impact in the ${ctx.market} market.`;

  const prompt = `You are an Education Intelligence Agent estimating the financial profile of a credential.

## HARD CONSTRAINT — Research Market: ${ctx.market}
All tuition ranges, salary impact figures, and duration estimates MUST reflect the ${ctx.market} market.

## Credential to enrich
- credentialName: ${credentialName}
- institution: ${institution || 'unspecified'}
- credentialType: ${credentialType}
- location: ${location || 'unspecified'}
- deliveryMode: ${deliveryMode || 'unspecified'}
- completionYear: ${completionYear ?? 'not specified'}

${yearContext}

## User Context
- currentJobTitle: ${ctx.currentJobTitle || 'unknown'}
- currentSalary: ${ctx.currentSalary || 'unknown'}

## Task
Estimate the following financial fields for this credential. If the credential is well-known (accredited degree, industry-standard certification, established bootcamp), use realistic market figures. If unusual or generic, use typical figures for its credentialType in the ${ctx.market} market.

Respond with ONLY valid JSON (no markdown, no explanation):
{
  "durationMonths": <integer, typical duration in months>,
  "tuitionMin": <integer, low estimate in local currency>,
  "tuitionMax": <integer, high estimate in local currency>,
  "salaryImpactPct": <integer 0-100, expected percent salary lift attributable to this credential>,
  "attributionPct": <float 0-1, how much of the salary jump is attributable to this credential vs. other factors; 0 means use the credentialType default>,
  "confidence": <float 0-1, how confident the estimate is>
}`;

  const callPerplexity = async (p: string): Promise<string> => {
    const res = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ENV.PERPLEXITY_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'sonar',
        messages: [
          {
            role: 'system',
            content:
              `You are an Education Intelligence Agent specializing in the ${ctx.market} education and credential market. ` +
              `Estimate credential financial profiles (tuition, duration, salary impact). ` +
              'Always respond with valid JSON only — no markdown, no explanation outside the JSON.',
          },
          { role: 'user', content: p },
        ],
        temperature: 0.2,
        max_tokens: 800,
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Perplexity error ${res.status}: ${body}`);
    }
    const data = await res.json() as { choices: Array<{ message: { content: string } }> };
    return data.choices[0]?.message?.content || '';
  };

  let parsed: Record<string, unknown> | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const content = await callPerplexity(
      attempt === 0 ? prompt : prompt + '\n\nIMPORTANT: Your previous response was not valid JSON. Respond with ONLY a single JSON object, no markdown fences, no extra text.',
    );
    try {
      const cleaned = content.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
      parsed = JSON.parse(cleaned);
      break;
    } catch {
      log.warn({ attempt, contentPreview: content.slice(0, 200) }, 'Failed to parse enrichment response');
      if (attempt === 1) throw new Error('Failed to parse Perplexity response after retry');
    }
  }

  if (!parsed) {
    throw new Error('Empty response from Perplexity');
  }

  const tuitionMin = Number(parsed.tuitionMin) || 0;
  const tuitionMax = Number(parsed.tuitionMax) || 0;
  const salaryImpactPct = Number(parsed.salaryImpactPct) || 0;
  const attributionPct = Number(parsed.attributionPct) || 0;

  const result: EnrichmentResult = {
    durationMonths: Number(parsed.durationMonths) || 6,
    tuitionMin: Math.min(tuitionMin, tuitionMax),
    tuitionMax: Math.max(tuitionMin, tuitionMax),
    tuitionMidpoint: Math.round((Math.min(tuitionMin, tuitionMax) + Math.max(tuitionMin, tuitionMax)) / 2),
    salaryImpactPct,
    salaryRoiPerYear: computeCredentialRoi(credentialType, attributionPct, null, salaryImpactPct, ctx),
    confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0.6)),
  };

  return result;
}
