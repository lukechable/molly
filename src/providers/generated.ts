import { randomBytes } from 'node:crypto';
import { fingerprint } from '../core/util.js';
import { isPlaceholder } from './common.js';
import type { Detection, Provider } from './types.js';

// Signing secrets only. Encryption keys are deliberately excluded: rotating them destroys data.
const NAMES =
  /^(JWT_SECRET(_KEY)?|SESSION_SECRET|NEXTAUTH_SECRET|AUTH_SECRET|BETTER_AUTH_SECRET|COOKIE_SECRET|CSRF_SECRET|SECRET_KEY_BASE|WEBHOOK_SIGNING_SECRET|CRON_SECRET)$/;

function inferShape(value: string): { encoding: string; bytes: string } {
  if (/^[0-9a-f]+$/i.test(value) && value.length % 2 === 0) return { encoding: 'hex', bytes: String(value.length / 2) };
  if (/^[A-Za-z0-9+/]+=*$/.test(value)) return { encoding: 'base64', bytes: String(Math.max(32, Math.floor((value.length * 3) / 4))) };
  return { encoding: 'base64url', bytes: '32' };
}

export function generateSecret(encoding: string, bytes: number): string {
  const buf = randomBytes(bytes);
  return encoding === 'hex' ? buf.toString('hex') : encoding === 'base64' ? buf.toString('base64') : buf.toString('base64url');
}

export const generated: Provider = {
  id: 'generated',
  name: 'Generated secrets',
  category: 'app',
  mode: 'auto',
  blurb: 'JWT/session/auth secrets: Molly generates fresh random values locally',
  fields: ['secret'],
  warning: 'Signing secrets change immediately; existing sessions/tokens become invalid.',
  detect(vars) {
    const out: Detection[] = [];
    for (const [key, value] of vars) {
      if (!NAMES.test(key) || isPlaceholder(value)) continue;
      out.push({
        provider: 'generated',
        identity: `generated:${fingerprint(value)}`,
        field: 'secret',
        key,
        label: key,
        params: inferShape(value),
        current: value,
      });
    }
    return out;
  },
  async issue(_ctx, cred) {
    const secret = generateSecret(cred.params.encoding ?? 'base64url', Number(cred.params.bytes ?? 32));
    return { values: { secret }, immediate: true };
  },
};
