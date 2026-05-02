/**
 * BullMQ Worker — Education Intelligence Agent
 *
 * Processes jobs from the 'edu-agent' queue.
 * Each job triggers a full agent run for a user.
 *
 * Handles two job types:
 * - run-agent (trigger=manual|scheduled|cia_notification): full 3-5 waypoint run
 * - run-agent (trigger=feedback_replacement): single replacement waypoint
 */

import { Worker, Job } from 'bullmq';
import { getRedis } from '../config/redis';
import { runAgentForUser } from '../services/agent.service';
import { createLogger } from '../config/logger';

const log = createLogger('agent-worker');

export interface AgentJobData {
  userId: string;
  trigger: 'manual' | 'scheduled' | 'cia_notification' | 'feedback_replacement' | 'add_new';
  replacingWaypointId?: string;
  credentialTypes?: string[];
}

export function startAgentWorker(): Worker<AgentJobData> {
  const worker = new Worker<AgentJobData>(
    'edu-agent',
    async (job: Job<AgentJobData>) => {
      const { userId, trigger, replacingWaypointId, credentialTypes } = job.data;

      log.info({ jobId: job.id, userId, trigger }, 'Processing agent job');

      try {
        const result = await runAgentForUser(userId, trigger, replacingWaypointId, credentialTypes);
        log.info({ jobId: job.id, ...result }, 'Agent job completed');
        return result;
      } catch (err) {
        log.error({ err, jobId: job.id, userId }, 'Agent job failed');
        throw err; // BullMQ will handle retry based on job options
      }
    },
    {
      connection: getRedis(),
      concurrency: 3, // Max 3 agent runs in parallel (Perplexity rate limit buffer)
      limiter: {
        max: 10,
        duration: 60000, // Max 10 runs per minute across all workers
      },
    },
  );

  worker.on('completed', (job, result) => {
    log.info({ jobId: job.id, result }, 'Worker: job completed');
  });

  worker.on('failed', (job, err) => {
    log.error({ jobId: job?.id, err }, 'Worker: job failed');
  });

  worker.on('error', (err) => {
    log.error({ err }, 'Worker: unhandled error');
  });

  log.info('Education agent worker started');
  return worker;
}
