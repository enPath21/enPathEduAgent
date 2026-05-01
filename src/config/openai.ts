/**
 * Perplexity client — uses OpenAI SDK pointed at Perplexity's API.
 * Model: sonar-pro (used for education pathway generation).
 */

import OpenAI from 'openai';
import { ENV } from './env';

export const perplexityClient = new OpenAI({
  apiKey: ENV.PERPLEXITY_API_KEY,
  baseURL: 'https://api.perplexity.ai',
});

export const PERPLEXITY_MODEL = 'sonar-pro';
