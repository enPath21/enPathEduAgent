/**
 * Education Match Service — finds real, currently-enrolling education programs
 * that align with the user's education pathway.
 *
 * Uses Perplexity sonar-pro (same pattern as agent.service.ts).
 */

import { randomUUID } from 'crypto';
import { ENV } from '../config/env';
import { createLogger } from '../config/logger';
import type { UserProfile, CIAContext, EducationMatch } from '../types';

const log = createLogger('educationMatch');

interface WaypointSummary {
  credentialName: string;
  institution: string;
  credentialType: string;
  projectedYear: number;
  position?: number;
  tuitionMin?: number;
  tuitionMax?: number;
  deliveryMode?: string;
  location?: string;
  rationale?: string;
  confidence?: number;
}

async function callPerplexity(prompt: string): Promise<{ content: string; citations: string[] }> {
  try {
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
              'You are an education program search specialist. You find real, currently-enrolling ' +
              'education programs from accredited institutions, online platforms, and training providers. ' +
              'Always respond with valid JSON only — no markdown, no explanation outside the JSON.',
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0.2,
        max_tokens: 2000,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Perplexity error ${res.status}: ${body}`);
    }

    const data = await res.json() as {
      choices: Array<{ message: { content: string } }>;
      citations?: string[];
    };

    return {
      content: data.choices[0]?.message?.content || '',
      citations: data.citations || [],
    };
  } catch (err) {
    log.error({ err: String(err) }, 'Perplexity fetch error');
    throw err;
  }
}

function buildEducationMatchPrompt(
  profile: UserProfile,
  ciaContext: CIAContext,
  waypoints: WaypointSummary[],
): string {
  const lines: string[] = [];

  lines.push('Find 3-4 real, currently-enrolling education programs for this candidate. Respond with ONLY a JSON array — no markdown, no explanation.');
  lines.push('');

  lines.push('## Candidate');
  if (profile.currentEducation) lines.push(`- Current education: ${profile.currentEducation}`);
  if (profile.highestDegree)    lines.push(`- Highest degree: ${profile.highestDegree}`);
  if (profile.institution)      lines.push(`- Institution: ${profile.institution}`);
  if (profile.fieldOfStudy)     lines.push(`- Field of study: ${profile.fieldOfStudy}`);
  if (profile.location)         lines.push(`- Location: ${profile.location}`);
  lines.push('');

  lines.push('## Target Credential');
  if (waypoints.length > 0) {
    const next = waypoints[0]!;
    lines.push('Find programs that match this target spec as closely as possible:');
    lines.push(`- Credential: ${next.credentialName}`);
    lines.push(`- Type: ${next.credentialType}`);
    if (next.institution)   lines.push(`- Target institution: ${next.institution}`);
    if (next.deliveryMode)  lines.push(`- Preferred delivery: ${next.deliveryMode}`);
    if (next.location)      lines.push(`- Preferred location: ${next.location || profile.location || 'any'}`);
    if (next.tuitionMin && next.tuitionMax) {
      lines.push(`- Budget: $${next.tuitionMin.toLocaleString()} – $${next.tuitionMax.toLocaleString()}`);
    }
  } else {
    lines.push('Find programs that advance the candidate to the next level in their field.');
    if (profile.location) lines.push(`- Preferred location: ${profile.location}`);
  }
  lines.push('');

  const activeGoals = (ciaContext.goals || []).filter(g => g.status === 'active').slice(0, 4);
  if (activeGoals.length > 0) {
    lines.push('## Education Goals (use to score matchPct — higher score for programs that advance these)');
    activeGoals.forEach(g => lines.push(`- [${g.category}] ${g.description}`));
    lines.push('');
  }

  lines.push('## Scoring');
  lines.push('Set matchPct based on how well each program matches the Target Credential spec and advances the education goals.');
  lines.push('90-100% = near-perfect match. 65-89% = good match. Below 65% = exclude.');
  lines.push('');

  lines.push('## Output format (JSON array only):');
  lines.push('[');
  lines.push('  {');
  lines.push('    "credentialName": "Program Name",');
  lines.push('    "institution": "Institution Name",');
  lines.push('    "location": "City, State or Remote",');
  lines.push('    "deliveryMode": "online" | "in-person" | "hybrid" | "flexible",');
  lines.push('    "tuitionMin": 5000,');
  lines.push('    "tuitionMax": 10000,');
  lines.push('    "salaryImpactPct": 25,');
  lines.push('    "salaryRoiPerYear": 15000,');
  lines.push('    "matchPct": 85,');
  lines.push('    "url": "https://..." or null,');
  lines.push('    "description": "1-2 sentence program overview",');
  lines.push('    "tags": ["tag1", "tag2"]');
  lines.push('  }');
  lines.push(']');

  return lines.join('\n');
}

function parseEducationMatches(content: string): EducationMatch[] {
  try {
    const cleaned = content.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    const parsed = JSON.parse(cleaned);

    const arr = Array.isArray(parsed) ? parsed : (parsed.matches || parsed.programs || [parsed]);

    return arr
      .filter((m: Record<string, unknown>) => m && m.credentialName && m.institution)
      .slice(0, 4)
      .map((m: Record<string, unknown>) => {
        const rawMin = Number(m.tuitionMin) || 0;
        const rawMax = Number(m.tuitionMax) || 0;
        const tuitionMin = rawMin <= rawMax ? rawMin : rawMax;
        const tuitionMax = rawMin <= rawMax ? rawMax : rawMin;
        return {
          matchId: randomUUID(),
          credentialName: String(m.credentialName),
          institution: String(m.institution),
          location: String(m.location || 'Remote'),
          deliveryMode: (['online','in-person','hybrid','flexible'].includes(String(m.deliveryMode))
            ? String(m.deliveryMode)
            : 'online') as EducationMatch['deliveryMode'],
          tuitionMin,
          tuitionMax,
          salaryImpactPct: Number(m.salaryImpactPct) || 0,
          salaryRoiPerYear: Number(m.salaryRoiPerYear) || 0,
          matchPct: Math.min(100, Math.max(1, Number(m.matchPct) || 70)),
          url: typeof m.url === 'string' && m.url.startsWith('http') ? m.url : null,
          description: String(m.description || ''),
          tags: Array.isArray(m.tags) ? m.tags.map(String).slice(0, 4) : [],
        };
      });
  } catch (err) {
    log.warn({ err, contentLength: content.length, contentPreview: content.slice(0, 200) }, 'Failed to parse Perplexity education match response');
    return [];
  }
}

export async function findEducationMatches(
  profile: UserProfile,
  ciaContext: CIAContext,
  waypoints: WaypointSummary[],
): Promise<EducationMatch[]> {
  const prompt = buildEducationMatchPrompt(profile, ciaContext, waypoints);
  log.info({ userId: profile.userId, waypointCount: waypoints.length }, 'Finding education matches via Perplexity');

  const { content } = await callPerplexity(prompt);
  const matches = parseEducationMatches(content);

  log.info({ userId: profile.userId, matchCount: matches.length }, 'Education matches found');
  return matches;
}
