import { aws } from './aws.js';
import { cloudflare } from './cloudflare.js';
import { datadog } from './datadog.js';
import { generated } from './generated.js';
import { anthropic, clerk, githubPat, stripe } from './guided.js';
import { github, vercel } from './hosts.js';
import { resend, sendgrid, twilio_ } from './messaging.js';
import { neonProvider } from './neon.js';
import { openai } from './openai.js';
import { supabase } from './supabase.js';
import type { Provider } from './types.js';

export const PROVIDERS: Provider[] = [
  openai,
  anthropic,
  aws,
  cloudflare,
  neonProvider,
  supabase,
  stripe,
  resend,
  sendgrid,
  twilio_,
  clerk,
  datadog,
  generated,
  github,
  vercel,
  githubPat,
];

export type Registry = Record<string, Provider>;

export const liveRegistry = (): Registry => Object.fromEntries(PROVIDERS.map((p) => [p.id, p]));
