/**
 * Real OpenAI client — gpt-4o-mini for structured extraction and formatting tasks.
 */

import OpenAI from 'openai';
import { ENV } from './env';

export const openaiClient = new OpenAI({
  apiKey: ENV.OPENAI_API_KEY,
});

export const OPENAI_MODEL = 'gpt-4o-mini';
