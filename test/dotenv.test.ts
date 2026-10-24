import { describe, expect, it } from 'vitest';
import { parseDotenv, setDotenvValue } from '../src/core/dotenv.js';
import { plainField, renderTemplate } from '../src/core/util.js';
import { neonTemplate } from '../src/providers/neon.js';

const SRC = `# comment
export A=one
B="two words" # trailing
C='single'
D=plain # note
MULTI="line1
line2"
EMPTY=
A=dup
`;

describe('dotenv', () => {
  it('parses quoting, export, comments and multiline values', () => {
    const m = Object.fromEntries(parseDotenv(SRC).map((e) => [e.key + (e.key === 'A' && e.value === 'dup' ? '2' : ''), e.value]));
    expect(m).toMatchObject({ A: 'one', A2: 'dup', B: 'two words', C: 'single', D: 'plain', MULTI: 'line1\nline2', EMPTY: '' });
  });

  it('rewrites values in place, preserving everything else', () => {
    let { text, count } = setDotenvValue(SRC, 'A', 'NEW');
    expect(count).toBe(2);
    expect(text).toContain('export A=NEW\n');
    expect(text).toContain('\nA=NEW\n');
    text = setDotenvValue(text, 'B', 'x"y').text;
    expect(text).toContain('B="x\\"y" # trailing');
    text = setDotenvValue(text, 'D', 'has space').text;
    expect(text).toContain('D="has space" # note');
    text = setDotenvValue(text, 'C', 'sk_live_1').text;
    expect(text).toContain("C='sk_live_1'");
    expect(text).toContain('# comment\n');
    const reparsed = Object.fromEntries(parseDotenv(text).map((e) => [e.key, e.value]));
    expect(reparsed.B).toBe('x"y');
    expect(reparsed.MULTI).toBe('line1\nline2');
  });
});

describe('templates', () => {
  it('renders fields with optional url-escaping', () => {
    expect(renderTemplate('postgres://u:{{password:url}}@h/db', { password: 'a/b@c' })).toBe('postgres://u:a%2Fb%40c@h/db');
    expect(plainField('{{secret}}')).toBe('secret');
    expect(plainField('x{{secret}}')).toBeUndefined();
    expect(() => renderTemplate('{{nope}}', {})).toThrow();
  });

  it('builds Neon URL templates that round-trip', () => {
    const url = 'postgresql://neondb_owner:npg_abc123@ep-cool-river-a1b2-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require';
    const t = neonTemplate(url)!;
    expect(t).toMatchObject({ password: 'npg_abc123', endpoint: 'ep-cool-river-a1b2', role: 'neondb_owner' });
    expect(renderTemplate(t.template, { password: 'npg_abc123' })).toBe(url);
    expect(neonTemplate('postgresql://u:p@db.example.com/x')).toBeUndefined();
  });
});
