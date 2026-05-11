# enPathEduAgent

**Education Intelligence Agent (EIA)** -- generates personalized education pathways for enPath users. Part of the [enPath](https://github.com/enPath21) AI career intelligence platform.

EIA researches credentials, programs, and certifications aligned with a user's career goals and produces a time-sequenced education pathway with cost and ROI projections.

## Tech Stack

- **Runtime**: Node.js 20, TypeScript
- **HTTP**: Express
- **Queue**: BullMQ + Redis (Upstash)
- **Database**: MongoDB Atlas via Mongoose (`enPathEdu` database)
- **AI**: Perplexity sonar-pro (pathway generation), OpenAI gpt-4o-mini (structured extraction)
- **Infrastructure**: Google Cloud Run, Cloud Build
- **Logging**: Pino

## Key Environment Variables

| Variable | Purpose |
|---|---|
| `INTERNAL_API_KEY` | Shared key for internal service-to-service auth |
| `MONGODB_URI` | MongoDB Atlas connection string (`enPathEdu` database) |
| `REDIS_URL` | Upstash Redis URL for BullMQ |
| `OPENAI_API_KEY` | OpenAI API key (gpt-4o-mini structured extraction) |
| `PERPLEXITY_API_KEY` | Perplexity API key (sonar-pro pathway generation) |
| `BACKEND_BASE_URL` | enPathEduBE URL (defaults to Cloud Run prod) |
| `CIA_BASE_URL` | enPathCIA URL (defaults to Cloud Run prod) |
| `JOBS_BACKEND_URL` | enPathJobsBE URL -- billing + career waypoints (defaults to Cloud Run prod) |
| `PORT` | HTTP listen port (default `8080`) |

## Local Development

```bash
# Install dependencies
npm install

# Create .env with required vars (see table above)
cp .env.example .env   # or create manually

# Run in dev mode (hot-reload)
npm run dev

# Type-check without emitting
npm run typecheck

# Build for production
npm run build

# Start production build
npm start
```

## Deploy

Deployed to **Google Cloud Run** via Cloud Build. A push to `main` triggers the build pipeline which uses the multi-stage `Dockerfile` (builder + runner).

The Cloud Run service name is `enpath-edu-agent`.

## API

| Method | Path | Description |
|---|---|---|
| POST | `/api/agent/run/:userId` | Enqueue an EIA run for a user |
| POST | `/api/agent/recalc/:userId` | Recalc salary ROI on accepted waypoints |
| GET | `/health` | Health check |

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for data flow, CIA integration, agent rules, and design details.
