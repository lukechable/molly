# molly

Rotate every API key your repos use with one command: `molly`.

```
molly
```

1. **Pick your work folder.** Molly suggests the folders on your machine that hold git repos.
2. **See what each repo uses.** Molly reads every repo's `.env*` / `.dev.vars` files and shows which services each
   one uses, plus where the repo also keeps secrets (GitHub Actions, Vercel).
3. **Rotate, one platform at a time.** For each platform, Molly logs you in, creates a new key through the
   platform's API, updates every repo that uses it, revokes the old key, and shows you ✓ before moving on.

You never paste a new key: the platform's API issues it. Next time, `molly` remembers your folder and logins and goes
straight to rotating.

Try it safely first: `molly demo` builds three throwaway repos with fake keys and runs the whole flow.

## Logging in

Molly uses each platform's own browser login when its CLI is installed:

| Platform | Login |
|---|---|
| GitHub | `gh auth login` (or an existing `gh` session) |
| Vercel | `vercel login` (or an existing Vercel CLI session) |
| AWS | `aws login` (or your existing AWS credentials) |
| Neon | `neonctl auth` |
| Supabase | `supabase login` |

Platforms that have no browser login for tools (OpenAI, Cloudflare, Resend, SendGrid, Twilio, Datadog) need an
**admin** key once. Molly opens the right page, and the key is stored in your OS keychain and reused from then on.
That admin key only lets Molly create and revoke keys. It is never written into your repos.

## What gets rotated

| Platform | What Molly does through the API |
|---|---|
| OpenAI | New project service-account key; deletes the old key |
| AWS | New IAM access key pair, verified with STS; deletes the old one |
| Cloudflare | Rolls the API token in place |
| Neon | Resets the role password and rewrites every `DATABASE_URL` (pooled and direct) |
| Supabase | New `sb_secret_…` key; deletes the old one |
| Resend, SendGrid, Twilio, Datadog | New key (same scopes where supported); deletes the old one |
| `JWT_SECRET`, `NEXTAUTH_SECRET`, `SESSION_SECRET`, … | Fresh random value (encryption keys are never touched) |

Each new value goes into every local env file, GitHub Actions secret (repo and environment level) and Vercel env var
that held the old one. Molly offers to redeploy Vercel projects at the end.

**No rotation API:** Stripe, Anthropic, Clerk and GitHub personal access tokens can only be created in their
dashboards. Molly shows which repos use them and links to the right page, but doesn't rotate them.

On the **first** run, Molly may not be able to tell which old key to revoke for platforms whose APIs don't reveal key
values (Resend, SendGrid). When that happens, it tells you where to revoke it. After that it knows the key IDs it
created, so every later run is fully automatic.

## Safety

- The new key is saved to your keychain before anything is written. If an update fails, the old key stays alive and
  the next run resumes with the same new key.
- Files are rewritten atomically, and quotes, `export` and comments are kept.
- Values edited outside Molly are left alone unless you pass `--force`.
- If a remote secret might hold a different key (e.g. a test key in `.env` and a live key in `.env.production`
  under the same name), Molly doesn't link it.
- The config (`~/.config/molly/molly.yaml`) holds no secret values.

## Commands

```
molly                  rotate (asks for your work folder the first time)
molly setup            pick a different work folder
molly status [-v]      what's managed, where, and when it was last rotated
molly finalize         revoke old keys kept alive with --keep-old
molly disconnect <p>   remove a platform's saved login from the keychain
molly demo             full walkthrough on fake repos
```

Flags: `--keep-old` (revoke later with `molly finalize`) and `--force`. For CI, `molly --plain` rotates everything in
the saved setup without prompts. `--only <platform>` and `--dry-run` work with `--plain`. Logins can come from env
vars (`MOLLY_OPENAI_ADMIN_KEY`, `MOLLY_GITHUB_TOKEN`, …).

## Development

```
npm install
npm run dev -- demo          # run from source
npm test
npm run build && npm link    # puts `molly` on your PATH
```

To add a platform, implement `Provider` (`src/providers/types.ts`): `detect` finds its keys in env files, and
`issue` / `revoke` / `verify` rotate them. Then register it in `src/providers/index.ts`.
