# shopify-sevdesk-sync — CLAUDE.md

## What this is

This app replaces the official (expensive, usage-priced) Shopify App Store SevDesk
integration for Aron's "Saurer Siggi" store with a self-hosted sync service. It
must coexist with a **live SevDesk account that already has invoices imported by
the old official app** — no duplicates, no lost history, no broken tax reporting.

- `plan.md` — the architecture/research plan. Treat it as the baseline spec.
  Its "Open Items" (§6) are real unknowns to resolve, not optional polish.
- `conversation.md` — raw research chat log that produced `plan.md`. Background
  only; `plan.md` supersedes it wherever they differ. Do not put this file, or
  `plan.md`, in the public GitHub repo — they're internal planning notes, not
  app source.

This is a real experiment for a real small business. Build a working,
deployed app — not a prototype that stops at "tests pass."

## Environment constraints (confirmed with Aron, do not re-ask)

- **No Shopify dev store.** Build and test directly against the live Siggi
  Shopify store. Use Shopify's "send test notification" for webhook payload
  shapes where possible; be conservative with anything that writes to Shopify
  (there's basically nothing to write — scopes are read-only per plan.md §3.1).
- **No SevDesk sandbox.** The live SevDesk account is the only environment.
  Do the read-only audit script (plan.md §7 step 1) *first*, before any code
  that writes to SevDesk exists. Do not run invoice-creation code against the
  live account without an explicit go-ahead checkpoint with Aron once it's
  ready — this is real accounting data.
- **Deploy target `ssh siggi-services-1` runs plain `docker compose`** — no
  Swarm, no existing Traefik stack to assume. Check what reverse proxy (if
  any) is already running there before assuming TLS termination method; ask
  Aron if unclear rather than guessing.
- **GitHub repo is public from the start.** Never commit secrets, tokens,
  `.env` files, real order/customer data, or SQLite DB files. Double-check
  `.gitignore` covers all of these before the first push.

## Orchestration model

You (the main session) are the orchestrator, not the sole implementer.

- Keep the main context for planning, integration, and review. Delegate actual
  implementation to subagents via the `Agent` tool, split by workstream:
  - SevDesk client (contact upsert, invoice/credit-note create, dedup query)
  - Shopify webhook routes (HMAC/session verification, backfill via Admin API)
  - Background sync worker (queue table + processor)
  - Embedded admin UI routes/components (App Bridge + Polaris, already scaffolded)
  - Test suite (unit + integration, fixture-based, Vitest)
  - Docker + CI pipeline (extend the scaffold's existing `Dockerfile`)
- Respect real dependencies: the SevDesk client and Shopify client need to
  exist and be tested before the sync logic that uses both; the API contract
  needs to be stable before the admin UI is wired to it.
- Run genuinely independent subagents in parallel (single message, multiple
  `Agent` calls). Don't parallelize things that share files you haven't
  designed an interface for yet.
- Before marking any component done: have it reviewed (`code-review` skill or
  a review subagent) and actually exercised (`/verify` or `/run`), not just
  covered by unit tests.
- Track work with tasks, not memory. Update the plan's Open Items (§6) as they
  get resolved — note the resolution inline in `plan.md` or in a short
  `FINDINGS.md`, whichever reads better once you're in it.

## Tech stack (deviation from plan.md — single stack, not Python+Node)

plan.md assumed a Python/FastAPI backend with a separate embedded-UI frontend.
That's superseded: `npm init @shopify/app@latest` already scaffolded a
**React Router 7** app (Remix's current name) with App Bridge, Polaris,
OAuth/session-token handling, and Prisma-backed session storage wired up and
working. Building a second Python service alongside it would mean
re-implementing OAuth/webhook-signature handling that's already solved here,
running two languages/runtimes, and a more complicated Dockerfile/compose —
not simpler, not more effective. Use one stack:

- **Everything in TypeScript**, inside the existing React Router app (`app/`
  routes for UI + API + webhooks). No separate Python service.
- **SevDesk client, dedup logic, credit-note logic**: plain TS modules, not
  routes — easy to unit test in isolation from HTTP.
- **Background sync worker**: a queue table in the existing Prisma/SQLite DB
  (extend `prisma/schema.prisma`, alongside the scaffold's `Session` model)
  polled by a lightweight in-process worker (`setInterval`-driven loop started
  from the server entrypoint, or a small standalone Node script run as a
  second `docker compose` service sharing the same DB file — pick whichever
  is simpler once the queue shape exists; don't reach for BullMQ/Redis unless
  volume genuinely demands it).
- **Storage**: same SQLite/Prisma DB for the sync-log/UI-visibility table
  (plan.md §4). SevDesk (`customerInternalNote`) stays the dedup source of
  truth — the local table is for UI display only, never authoritative for
  dedup.
- **Container**: the scaffold already ships a working `Dockerfile` (Prisma
  generate/migrate + `react-router-serve`) — extend it, don't replace it.
  Add a `docker-compose.yml` for the VPS. Keep the CI pipeline to
  build → test → push; no multi-env promotion or speculative extras.

## Coding standards

- Strict TypeScript everywhere, no `any`.
- Lint/format gates already scaffolded (`eslint`, `prettier`) — keep them
  green in CI, don't relax rules to make code pass.
- No comments that restate what the code does. Only comment a genuinely
  non-obvious *why* (a workaround, a hidden constraint, a subtle invariant).
  Keep any comment to one line.
- No speculative abstractions, no config flags for hypothetical futures, no
  half-finished code paths. Three similar lines beats a premature helper.
- Small, focused modules; explicit over clever.

## Data handling (hard rule)

- Never write real customer personal data — names, emails, addresses, phone
  numbers — into code, tests, fixtures, logs, commit messages, or your own
  chat output. Use synthetic data for every fixture and example.
- The app itself necessarily passes real customer data through (Shopify order
  → SevDesk invoice/contact) — that's its job. But it must not log PII: log
  order IDs and status, never full order/customer payloads at info level, and
  never persist more customer data locally than the sync-log table needs
  (order id, status, timestamp — not names/emails).
- The audit script and any live-data debugging should print/redact rather
  than dump raw customer fields to terminal output that ends up in this
  conversation.

## Testing strategy

- No test may write to the live SevDesk account or perform destructive/live
  actions against the live Shopify store. Mock both APIs with fixture
  payloads built from synthetic data for unit/integration tests.
- The read-only audit script (plan.md §7 step 1) is the one exception allowed
  to hit live SevDesk — it only reads. Confirm with Aron before running
  anything beyond that against production.
- Test pyramid (Vitest): unit tests for payload mapping + dedup logic,
  integration tests against mocked HTTP, one fixture-based end-to-end smoke
  test wired into CI.

## Git / GitHub

- Commit as Aron, full stop — **do not add "Co-Authored-By: Claude" or any
  Claude/Anthropic attribution to any commit.** No AI trailer, ever. He does
  not want Claude showing up as a contributor on GitHub.
- Conventional commit messages; explain why, not what.
- Public repo from commit one: verify `.gitignore` excludes `.env`, `*.db`,
  `/data`, any credentials file, and `plan.md`/`conversation.md`, before the
  first push. Never commit a `.env` — ship `.env.example` with empty/dummy
  values instead.

## Deployment

- Target: `ssh siggi-services-1`, plain `docker compose` (confirmed — no
  Swarm, no assumed existing Traefik stack). Check what's already running
  there (reverse proxy, ports in use) before writing the compose file; ask
  Aron if it's unclear rather than guessing blind.
- Shopify webhooks and the embedded admin UI's App URL both need a public TLS
  endpoint — get the domain/subdomain from Aron before finalizing config.
- Ship: `Dockerfile`, `docker-compose.yml`, and a GitHub Actions workflow that
  builds, tests, and pushes the image on merge to `main`. Keep it to that —
  no multi-stage environments, no unnecessary matrix builds.

## Decisions on plan.md gaps (resolved with Aron — do not re-ask)

1. **Refunds/cancellations are in scope for v1.** Handle `orders/cancelled`
   and `refunds/create` webhooks: if a SevDesk invoice already exists for the
   order (found via the same `customerInternalNote` dedup check), create a
   SevDesk credit note (`CreditNote`) referencing it rather than silently
   ignoring the event or leaving the books wrong. Same dedup-first pattern as
   invoice creation.
2. **Shopify mandatory compliance webhooks** (`customers/data_request`,
   `customers/redact`, `shop/redact`): implement minimal stub handlers (verify
   HMAC, return 200, log receipt) even though this is a custom/non-listed app
   — cheap to add, avoids relying on an assumption about whether Shopify
   enforces this for custom-distribution apps.
3. **No cross-border sales right now** — skip OSS/cross-border VAT logic
   entirely. Don't build for it speculatively; revisit only if Siggi starts
   selling outside Germany.
4. **Secrets via `.env`.** Local dev: `.env` (gitignored), `.env.example`
   committed with dummy values. Deploy: `.env` file placed on
   `siggi-services-1` directly (e.g. `scp`) and referenced by
   `docker-compose.yml`'s `env_file` — no secrets manager, keep it simple.

## Shopify app creation: use Shopify CLI (not the static-token "Develop apps" route)

Deviation from plan.md §3.1's "no OAuth dance" assumption: we're using the
**Shopify CLI** (`npm init @shopify/app@latest`) with the **React Router app**
template (Remix's current name) instead of a manually-created static-token
custom app via Admin → Settings → Develop apps. Reasoning:

- We need an embedded admin UI (App Bridge + Polaris) anyway — the CLI
  template ships that wired up correctly (session tokens, OAuth token
  exchange, webhook subscriptions via `shopify.app.toml`), which directly
  resolves plan.md §6 open item #6 instead of hand-rolling it.
- App is registered in a Shopify Partner org and installed to the live Siggi
  store via **custom distribution** (single-store install link, not App Store
  listed) — still no public review, just a one-time OAuth install instead of
  a static Admin token.
- `read_orders`/`read_customers` scopes declared in `shopify.app.toml`, same
  as plan.md specifies.
- Aron ran `npm init @shopify/app@latest`, logged into the "Saurer Siggi
  Likör" Partner org, picked the React Router + TypeScript template. Shopify
  app name is **`sevdesk-sync`** (Shopify rejects "shopify" inside app
  names, hence not matching the repo folder name exactly). Repo/folder stays
  `shopify-sevdesk-sync`; Shopify-side app name is `sevdesk-sync`. Continue
  from that scaffold — don't recreate the app or switch templates.

## Definition of done

- Shopify app installed on the live Siggi store via custom distribution,
  `read_orders`/`read_customers` scopes granted, webhooks registered, HMAC/
  session-token verification working.
- SevDesk client: contact upsert-by-email, invoice creation, dedup query via
  `customerInternalNote` — each confirmed against a real (or at least
  read-only-tested) SevDesk response, not assumed from docs alone.
- Backfill job and webhook-driven live sync both go through the same sync
  code path and dedup logic.
- Embedded admin UI: enable/disable sync, trigger backfill with a date range,
  status + recent-log view, manual retry — per plan.md §4.
- Dockerized, CI green, deployed and reachable on `siggi-services-1` behind
  TLS.
- Plan.md §6 Open Items and the gaps listed above are each either resolved or
  explicitly written down as still-open with a reason.
- Public GitHub repo exists, pushed, no secrets/PII in history.

## Access Claude will need from Aron (ask when actually blocked, not before)

- Shopify: `shopify app dev`/`deploy` handles OAuth + API secret via the
  Partner org already logged into — no manual token needed unless something
  breaks. Aron needs to complete the install-link OAuth approval on the live
  store once, since that step happens in a browser.
- SevDesk API token.
- Target domain/subdomain for the public webhook + admin UI endpoint.
- GitHub account/org to create the repo under. Repo name: `shopify-sevdesk-sync`
  (matches folder name). Shopify app name is separately `sevdesk-sync` — don't
  try to make these match, Shopify disallows "shopify" in app names.
- Confirmation before any code performs its first live write to SevDesk.
