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
import { checkBalance, reportUsage } from '../services/billing.client';
import { createLogger } from '../config/logger';

const log = createLogger('agent-worker');

export interface AgentJobData {
  userId: string;
  trigger: 'manual' | 'scheduled' | 'cia_notification' | 'feedback_replacement' | 'add_new';
  replacingWaypointId?: string;
  credentialTypes?: string[];
  lastAcceptedYear?: number;
}

export function startAgentWorker(): Worker<AgentJobData> {
  const worker = new Worker<AgentJobData>(
    'edu-agent',
    async (job: Job<AgentJobData>) => {
      const { userId, trigger, replacingWaypointId, credentialTypes, lastAcceptedYear } = job.data;

      log.info({ jobId: job.id, userId, trigger }, 'Processing agent job');

      // Billing pre-check
      const balance = await checkBalance(userId);
      if (!balance.allowed) {
        log.warn({ jobId: job.id, userId, reason: balance.reason }, 'Insufficient balance — skipping agent run');
        return { error: 'INSUFFICIENT_BALANCE', runId: '', waypointCount: 0 };
      }

      try {
        const result = await runAgentForUser(userId, trigger, replacingWaypointId, credentialTypes, lastAcceptedYear);
        log.info({ jobId: job.id, ...result }, 'Agent job completed');

        // Billing post-deduct (EIA uses 1 Perplexity call for all waypoints)
        await reportUsage({
          userId,
          agentId: 'EIA',
          trigger,
          runId: result.runId,
          model: 'sonar-pro',
          inputTokens: 2000,
          outputTokens: 2000,
        });

        return result;
      } catch (err) {
        log.error({ err, jobId: job.id, userId }, 'Agent job failed');
        throw err; // BullMQ will handle retry based on job options
      }
    },
    {
      connection: getRedis(),
      concurrency: 3, // Max 3 agent runs in parallel (Perplexity rate limit buffer)
      lockDuration: 300000, // 5 min — prevents stall detection during long Perplexity calls
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
