import dotenv from 'dotenv';
dotenv.config();

export const ENV = {
  PORT: parseInt(process.env.PORT || '8080', 10),
  MONGODB_URI: process.env.MONGODB_URI || 'mongodb+srv://enpath-backend-svc:MONGO_PASS_REDACTED@enpathcluster0.ibzri.mongodb.net/enPathEdu?appName=enPathCluster0',
  REDIS_URL: process.env.REDIS_URL || 'rediss://default:REDIS_PASS_REDACTED@proper-lemur-108236.upstash.io:6379',
  PERPLEXITY_API_KEY: process.env.PERPLEXITY_API_KEY || 'PERPLEXITY_KEY_REDACTED',
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || 'OPENAI_KEY_REDACTED',
  INTERNAL_API_KEY: process.env.INTERNAL_API_KEY || 'INTERNAL_API_KEY_REDACTED',
  BACKEND_BASE_URL: process.env.BACKEND_BASE_URL || 'https://enpath-edu-be-285173621267.us-central1.run.app',
  CIA_BASE_URL: process.env.CIA_BASE_URL || 'https://enpath-cia-285173621267.us-central1.run.app',
  JOBS_BACKEND_URL: process.env.JOBS_BACKEND_URL || 'https://enpath-backend-285173621267.us-central1.run.app',
};
