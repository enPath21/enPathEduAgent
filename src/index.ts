import express from 'express';
import cors from 'cors';
import { ENV } from './config/env';
import { connectDatabase } from './config/database';
import { createLogger } from './config/logger';
import { startAgentWorker } from './workers/agent.worker';
import agentRoutes from './routes/agent.routes';
import healthRoutes from './routes/health.routes';

const log = createLogger('index');

async function main() {
  // Connect to MongoDB
  await connectDatabase();

  // Start BullMQ worker
  startAgentWorker();

  // Express app
  const app = express();
  app.use(cors());
  app.use(express.json());

  // Routes
  app.use(healthRoutes);
  app.use('/api/agent', agentRoutes);

  // 404
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.listen(ENV.PORT, () => {
    log.info({ port: ENV.PORT }, 'enPathEduAgent listening');
  });
}

main().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
