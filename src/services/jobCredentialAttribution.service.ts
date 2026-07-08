/**
 * Job × Credential Attribution
 *
 * For a specific job (or archetype waypoint) and the set of credentials a
 * user actually holds, classify each credential as required / preferred /
 * irrelevant for that job, and assign a weight for splitting attribution
 * within its necessity tier.
 *
 * Called by /enrich-job-credentials. Cached globally by
 * (market, normalizedJobTitle, credentialFingerprint) via AttributionCacheModel.
 *
 * See edu-salary-attribution-spec.md for the full model.
 */

import { ENV } from '../config/env';
import { createLogger } from '../config/logger';

const log = createLogger('job-credential-attribution');

export interface CredentialInput {
  credentialId: string;
  name: string;
  type?: string;
  completionYear?: number | null;
}

export interface JobInput {
  title: string;
  industry?: string;
  seniority?: string;
}

export interface Attribution {
  credentialId: string;
  credentialName: string;
  necessity: 'required' | 'preferred' | 'irrelevant';
  weight: number;
  confidence: number;
  reasoning: string;
}

export function normalizeJobTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function credentialFingerprint(credentials: CredentialInput[]): string {
  return credentials
    .map(c => (c.name || '').toLowerCase().replace(/[^\w]/g, ''))
    .filter(Boolean)
    .sort()
    .join('|');
}

/**
 * Call Perplexity to research the necessity + weight for each credential
 * against a specific job.
 */
export async function researchJobCredentialAttribution(
  market: string,
  job: JobInput,
  credentials: CredentialInput[],
): Promise<Attribution[]> {
  if (credentials.length === 0) return [];

  const credLines = credentials
    .map((c, i) => `  ${i + 1}. ${c.name}${c.type ? ` (${c.type})` : ''}${c.completionYear ? ` — completed ${c.completionYear}` : ''}`)
    .join('\n');

  const prompt = `You are an Education Intelligence Agent evaluating whether specific credentials qualify a person for a specific job in the ${market} labor market.

## HARD CONSTRAINT — Research Market: ${market}
All licensing, degree, and certification requirements must reflect the ${market} labor market conventions.

## Job
- Title: ${job.title}
${job.industry ? `- Industry: ${job.industry}\n` : ''}${job.seniority ? `- Seniority: ${job.seniority}\n` : ''}
## Credentials the person holds
${credLines}

## Task
For each credential, classify its role for the job above:

- "required": legally required or so standard that it is effectively required (BSN for RN in the US, JD for practicing attorney, MD for physician). Without this credential, the person cannot hold the job.
- "preferred": materially boosts salary or hire-ability but is not a hard requirement (specialty certifications on top of a base license, industry certs on top of a degree).
- "irrelevant": credential does not qualify or boost hire-ability for this specific job (a nursing degree for a bartender job).

Then assign a weight within its necessity tier (weights within a tier must sum to 1.0). If a tier has one credential, weight = 1.0. If multiple, split by the credential's relative importance to the job.

Respond with ONLY valid JSON (no markdown, no explanation):
{
  "attributions": [
    { "credentialIndex": 1, "necessity": "required" | "preferred" | "irrelevant", "weight": <float 0-1>, "confidence": <float 0-1>, "reasoning": "<one sentence>" }
  ]
}

Rules:
- Weights within EACH necessity tier must sum to 1.0 (± 0.01).
- Irrelevant credentials: weight = 0, confidence still 0-1.
- Base confidence on how well-established the requirement is; niche/unusual credentials for a job → lower confidence.
- credentialIndex is 1-based, matching the list above.`;

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
              `You are an Education Intelligence Agent specializing in the ${market} labor market. ` +
              'You evaluate whether specific credentials qualify a person for specific jobs. ' +
              'Always respond with valid JSON only — no markdown, no explanation outside the JSON.',
          },
          { role: 'user', content: p },
        ],
        temperature: 0.2,
        max_tokens: 1200,
      }),
      signal: AbortSignal.timeout(45000),
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
      log.warn({ attempt, contentPreview: content.slice(0, 200) }, 'Failed to parse attribution response');
      if (attempt === 1) throw new Error('Failed to parse Perplexity response after retry');
    }
  }

  if (!parsed || !Array.isArray(parsed.attributions)) {
    throw new Error('Malformed attribution response: no attributions array');
  }

  const rawAttributions = parsed.attributions as Array<Record<string, unknown>>;
  const result: Attribution[] = [];

  for (const raw of rawAttributions) {
    const idx = Number(raw.credentialIndex);
    if (!Number.isFinite(idx) || idx < 1 || idx > credentials.length) continue;
    const cred = credentials[idx - 1];
    const necessity = String(raw.necessity) as 'required' | 'preferred' | 'irrelevant';
    if (!['required', 'preferred', 'irrelevant'].includes(necessity)) continue;
    result.push({
      credentialId:   cred.credentialId,
      credentialName: cred.name,
      necessity,
      weight:     Math.max(0, Math.min(1, Number(raw.weight) || 0)),
      confidence: Math.max(0, Math.min(1, Number(raw.confidence) || 0.5)),
      reasoning:  String(raw.reasoning || ''),
    });
  }

  // Normalize weights within each necessity tier to sum to 1.0
  for (const necessity of ['required', 'preferred'] as const) {
    const tier = result.filter(a => a.necessity === necessity);
    const sum = tier.reduce((s, a) => s + a.weight, 0);
    if (sum > 0 && Math.abs(sum - 1) > 0.01) {
      for (const a of tier) a.weight = a.weight / sum;
    } else if (sum === 0 && tier.length > 0) {
      // Perplexity returned all-zero weights — equal split
      for (const a of tier) a.weight = 1 / tier.length;
    }
  }
  // Irrelevant tier: force weight = 0
  for (const a of result) if (a.necessity === 'irrelevant') a.weight = 0;

  return result;
}
