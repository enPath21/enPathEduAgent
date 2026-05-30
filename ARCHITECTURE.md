# enPathEduAgent Architecture

## Overview

The Education Intelligence Agent (EIA) generates personalized education pathways for users. It mirrors the enPathJobsAgent (JIA) architecture exactly, substituting career waypoints for education waypoints.

## Data Flow

1. **Billing**: POST `/api/billing/charge-internal` on enpath-backend charges 7&#162; &times; `pricingMultiplier` before the run starts. If the user has insufficient balance the run is rejected with `402 INSUFFICIENT_BALANCE`.
2. **Trigger**: POST `/api/agent/run/:userId` enqueues a BullMQ job.
3. **Worker**: Picks up the job and calls `agent.service.ts`.
4. **Data Gathering** (parallel):
   - Education history from MongoDB (`educationitems` collection)
   - Career waypoints from enPathJobsBE (what roles the user is targeting)
   - CIA context filtered for education intent (goal-aware waypoint generation)
5. **Perplexity Call**: sonar-pro generates 3-5 education waypoints.
6. **Save**: Waypoints saved to `education_waypoints` collection.
7. **Notify**: CIA + backend notified (fire-and-forget).

## CIA Integration

The Career Intelligence Agent (enPathCIA) provides goal-aware context for waypoint generation:

- At step 4 the worker fetches the user's active CIA goals filtered to the `education` module.
- CIA goals influence Perplexity prompt construction: they act as **scoring signals** that boost `matchPct` for programs advancing those goals, not as hard exclusion filters (hard filters caused sonar-pro to over-filter and return empty results).
- The Position 1 waypoint (nearest accepted education waypoint) is used as the primary search template; CIA education goals supplement it.

## Agent Rules

- **Never delete existing waypoints on re-run.** A re-run recalculates numbers (salary ROI, timeline) but does not add, remove, or reorder existing pathway items.
- **Add exactly 3 items on user insert (`add_new`).** Appends 3 new pending waypoints without touching existing pending or accepted items.
- **Pending items persist indefinitely.** Pending waypoints are never auto-deleted. They remain until the user explicitly accepts or declines them, even if the user returns weeks or months later.
- Auto-run = recalc numbers only; never touch pathway items.

## Agent Run Guard (CRITICAL)

`runAgentForUser` in `agent.service.ts` blocks any run where trigger is not `feedback_replacement` or `add_new` and no `replacingWaypointId` is present. This is the primary protection against stale BullMQ jobs firing on Cloud Run cold-start and wiping user waypoints.

**Valid production triggers:**
- `feedback_replacement` + `replacingWaypointId` — user clicked "Suggest Another" on a pending card (1-for-1 swap)
- `add_new` — user clicked "Insert New Education Item" (appends 3 new pending items, never deletes anything)

**All other triggers are blocked** (`manual`, `scheduled`, `cia_notification`, etc.) — ghost runs from stale Redis queue jobs.

The `add_new` path never calls `deleteMany` — it only appends. Accepted and existing pending items are always preserved.

## Education Matches

### Perplexity Prompt Design

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
| Run cost | 10&#162; | 7&#162; |

## Tech Stack

- TypeScript + Node.js
- Express for HTTP
- BullMQ + Redis (Upstash) for job queue
- Mongoose + MongoDB (`enPathEdu` database)
- Perplexity API (sonar-pro) for pathway generation
- OpenAI gpt-4o-mini for structured extraction

---

## Geo Data Source Injection

The Education Agent scopes all credential/program research to the user's intended market.

### `UserProfile` Type

The `UserProfile` type must include the `geoDataSource` field:

```typescript
interface UserProfile {
  // ... existing fields ...
  location?: string;        // "where I live" -- display/context only
  geoDataSource?: string;   // "where I want opportunities" -- used to scope research
}
```

### Priority Order for Market Scoping

1. **CIA location goal** -- if an active CIA goal contains a location intent, that scopes the education search.
2. **`geoDataSource`** -- the default research market when no CIA location goal is active.
3. **`profile.location`** -- fallback/display context only.

### Known Issue: `educationMatch.service.ts`

`educationMatch.service.ts` currently uses `profile.location` directly for market scoping. This is a known issue -- the service will be updated as part of the Geo Data Source implementation to prefer `geoDataSource` over `profile.location`, using the same priority order as the Jobs Agent.

> **Status:** Geo Data Source is designed, not yet built.
