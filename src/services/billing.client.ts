/**
 * Billing Client — calls enPathJobsBE billing API endpoints
 */

import { ENV } from '../config/env';
import { createLogger } from '../config/logger';

const log = createLogger('billing-client');

const JOBS_BACKEND_URL = ENV.JOBS_BACKEND_URL;
const API_KEY = ENV.INTERNAL_API_KEY;

export interface BalanceCheck {
  allowed: boolean;
  reason?: string;
  balanceCents: number;
}

export async function checkBalance(userId: string): Promise<BalanceCheck> {
  try {
    const res = await fetch(`${JOBS_BACKEND_URL}/api/billing/check/${userId}`, {
      headers: { 'x-api-key': API_KEY },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      log.warn({ userId, status: res.status }, 'Balance check failed — allowing by default');
      return { allowed: true, balanceCents: -1 };
    }
    return await res.json() as BalanceCheck;
  } catch (err) {
    log.warn({ err, userId }, 'Balance check error — allowing by default');
    return { allowed: true, balanceCents: -1 };
  }
}

export async function reportUsage(params: {
  userId: string;
  agentId: string;
  trigger: string;
  runId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}): Promise<void> {
  try {
    const res = await fetch(`${JOBS_BACKEND_URL}/api/billing/deduct`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      log.warn({ status: res.status, userId: params.userId }, 'Billing deduct call failed');
    }
  } catch (err) {
    log.warn({ err, userId: params.userId }, 'Billing deduct error — non-blocking');
  }
}
