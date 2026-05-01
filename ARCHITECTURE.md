# enPathEduAgent Architecture

## Overview

The Education Intelligence Agent (EIA) generates personalized education pathways for users. It mirrors the enPathJobsAgent (JIA) architecture exactly, substituting career waypoints for education waypoints.

## Data Flow

1. **Trigger**: POST `/api/agent/run/:userId` enqueues a BullMQ job
2. **Worker**: Picks up the job and calls `agent.service.ts`
3. **Data Gathering** (parallel):
   - Education history from MongoDB (`educationitems` collection)
   - Career waypoints from enPathJobsBE (what roles the user is targeting)
   - CIA context filtered for education intent
4. **Perplexity Call**: sonar-pro generates 3-5 education waypoints
5. **Save**: Waypoints saved to `education_waypoints` collection
6. **Notify**: CIA + backend notified (fire-and-forget)

## Education Matches

### Perplexity Prompt Design

Prompt design: CIA goals influence matchPct scoring — they are NOT hard exclusion filters. Hard filters caused sonar-pro to over-filter and return empty results.

The Position 1 waypoint (nearest accepted education waypoint) is used as the primary search template. CIA education goals are presented as scoring signals to boost matchPct for programs that advance them, rather than as hard constraints that exclude otherwise-valid programs.

## Key Differences from JIA

| Aspect | JIA | EIA |
|--------|-----|-----|
| Domain | Career waypoints (jobs) | Education waypoints (credentials) |
| Collection | `career_waypoints` | `education_waypoints` |
| Queue name | `jobs-agent` | `edu-agent` |
| Database | `enPathJobs` | `enPathEdu` |
| Audit source | `jia` | `eia` |
| CIA module | `jobs` | `education` |
| Match service | `jobMatch.service.ts` | `educationMatch.service.ts` |

## Tech Stack

- TypeScript + Node.js
- Express for HTTP
- BullMQ + Redis (Upstash) for job queue
- Mongoose + MongoDB (`enPathEdu` database)
- Perplexity API (sonar-pro) for pathway generation
- OpenAI gpt-4o-mini for structured extraction
