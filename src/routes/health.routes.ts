import { Router } from 'express';
import { mongoose } from '../config/database';

const router = Router();

router.get('/health', (_req, res) => {
  const dbState = mongoose.connection.readyState;
  // 1 = connected, 2 = connecting
  const dbOk = dbState === 1 || dbState === 2;
  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? 'ok' : 'degraded',
    db: dbState,
    ts: new Date().toISOString(),
  });
});

router.get('/ready', (_req, res) => {
  res.status(200).send('ready');
});

export default router;
