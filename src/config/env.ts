import dotenv from 'dotenv';
dotenv.config();

function required(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`FATAL: ${name} environment variable is not set`);
    process.exit(1);
  }
  return val;
}

export const ENV = {
  PORT: parseInt(process.env.PORT || '8080', 10),
  MONGODB_URI: required('MONGODB_URI'),
  REDIS_URL: required('REDIS_URL'),
  PERPLEXITY_API_KEY: required('PERPLEXITY_API_KEY'),
  OPENAI_API_KEY: required('OPENAI_API_KEY'),
  INTERNAL_API_KEY: required('INTERNAL_API_KEY'),
  BACKEND_BASE_URL: process.env.BACKEND_BASE_URL || 'https://enpath-edu-be-285173621267.us-central1.run.app',
  CIA_BASE_URL: process.env.CIA_BASE_URL || 'https://enpath-cia-285173621267.us-central1.run.app',
  JOBS_BACKEND_URL: process.env.JOBS_BACKEND_URL || 'https://enpath-backend-285173621267.us-central1.run.app',
};
