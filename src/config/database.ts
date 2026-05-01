import mongoose from 'mongoose';
import { ENV } from './env';
import { createLogger } from './logger';

const log = createLogger('database');

let connected = false;

export async function connectDatabase(): Promise<void> {
  if (connected) return;
  try {
    await mongoose.connect(ENV.MONGODB_URI);
    connected = true;
    log.info('MongoDB connected (enPathEdu cluster)');
  } catch (err) {
    log.error({ err }, 'MongoDB connection failed');
    throw err;
  }
}

export { mongoose };
