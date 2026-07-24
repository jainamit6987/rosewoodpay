# Society App Progress Log

This file records completed work, decisions, open questions, and the next implementation step for the residential society maintenance payment app.

## 2026-07-23

### Completed

* Reviewed the original product and technical specification.
* Confirmed the MVP direction: UPI initiation, receipt or UTR submission, AI-assisted extraction, administrator review, digital receipts, and ledger export.
* Recorded the decision that receipt extraction must remain separate from actual payment verification.
* Added a multi-society PostgreSQL/Supabase schema covering societies, members, flats, resident assignments, billing periods, transactions, and audit events.
* Added security and privacy rules for Row Level Security, private proof files, signed URLs, and audit history.
* Added the transaction state transition model with retry, locking, manual review, rejection, and verification rules.

### Current Design Baseline

* Residents are linked to flats only after administrator approval.
* The society controls the amount due for each billing period.
* AI results are untrusted until independently validated.
* Only `Verified` transactions count in the resident ledger.
* Queue state is stored in the database so processing survives worker restarts and free-tier sleep.

### Next Steps

1. Write the first Supabase SQL migration from the schema in the specification.
2. Decide whether to use PostgreSQL enums or `VARCHAR` values with check constraints for lifecycle fields.
3. Define the initial Row Level Security policies for residents, administrators, and committee members.
4. Create seed data for one test society, one administrator, one resident, one flat, and one open billing period.
5. Add focused tests for transaction state transitions and duplicate UTR handling.

### Open Decisions

* Confirm the first payment-verification source: manual admin confirmation, bank statement import, or payment gateway webhook.
* Confirm whether one resident may be assigned to multiple flats.
* Confirm the society's billing rules for partial payments, overpayments, late fees, and previous balances.
* Confirm the required receipt retention period and administrator audit-retention period.

## Next Resume Action Plan

The database schema and seed data are complete. On the next work session, start here and work through the list in order.

### Action 1: Verify the Local Baseline

* Start Docker Desktop if it is not running.
* Run `npx supabase start` and `npx supabase status`.
* Run `npx supabase db reset` and confirm the seed completes without errors.
* Confirm the seeded test accounts exist:
	* `admin@society.app` / `password`
	* `resident@society.app` / `password`
* Do not use these credentials outside local development.

**Completion check:** A clean reset succeeds and the local Supabase API and Studio URLs are available.

### Action 2: Choose and Scaffold the API Layer

* Use the installed Node.js toolchain and Supabase client libraries unless a specific backend requirement changes this decision.
* Create a minimal API/client integration layer for local development.
* Keep service-role credentials server-side only; the mobile client must use the local publishable or anonymous key.
* Add environment-variable templates without committing secrets.

**Completion check:** A health check can connect to local Supabase, and no secret key is exposed to client code.

### Action 3: Implement Authentication and Profile Access

* Implement email/password sign-in for the seeded admin and resident accounts.
* Add session persistence and sign-out.
* Load the authenticated user's society membership.
* For residents, load only their approved house assignments and open billing periods.
* For admins, load society members, houses, and billing periods according to the RLS policies.

**Completion check:** Resident and admin test sessions can sign in and receive different data scopes enforced by RLS.

### Action 4: Add Focused Database Tests

* Test resident access to an assigned house and denial of another house's data.
* Test admin access to the society ledger and resident write restrictions.
* Test duplicate UTR rejection within one society.
* Test billing-period and house foreign-key relationships.
* Test the transaction state transition rules before adding payment UI.

**Completion check:** The tests demonstrate both allowed behavior and denied access; do not rely only on successful requests.

### Action 5: Prepare the Transaction Submission Slice

* Add the first transaction submission endpoint or client operation.
* Allow a resident to submit only for an approved house and open billing period.
* Store receipt metadata and optional private proof-file path.
* Start new submissions in `Submitted` or `Queued`; do not mark them `Verified` from a receipt upload.
* Record the next implementation result and any blockers in this log.

**Completion check:** A local resident can create a valid pending transaction, while invalid house, billing-period, and unauthorized submissions are rejected.

### Decisions to Make Before Action 2

* Confirm whether the first API layer should remain client-only with Supabase or include a separate FastAPI/Node service.
* Confirm whether one resident may be assigned to multiple houses.
* Confirm the first payment-verification source: manual administrator confirmation, bank statement import, or payment gateway webhook.

### Local Development Environment

* Installed Node.js `v24.18.0`, npm `11.16.0`, and Docker Desktop `4.83.0`.
* Docker Desktop cannot start because the HP notebook reports `Virtualization Enabled In Firmware: No`.
* Docker Hub sign-in is not required for local development.
* Next environment step: enable Intel Virtualization Technology in HP BIOS/UEFI, then verify Docker with `docker info`.

### Schema Finalization & Application (2026-07-24)

* Verified that Gemini Code Assist is installed in VS Code as `google.geminicodeassist@2.93.0`.
* Created `GEMINI_CODE_ASSIST_HANDOFF.md` with the project context and a ready-to-paste continuation prompt.
* Verified Docker Desktop is running and `npx supabase start` is successful.
* Iteratively refined the initial SQL migration (`YYYYMMDDHHMMSS_initial_schema.sql`) to handle multiple house types, separate Admin (write) and Committee (read) permissions, and allow for admin-recorded cash payments.
* Resolved local environment issues (PowerShell policy, Docker port conflicts, Supabase Analytics on Windows).
* Successfully started the local Supabase stack and applied the finalized schema using `npx supabase db reset`.

### Next Steps

1. **(Done)** Create seed data for one test society, one administrator, one resident, two houses, and an open billing period for each house.
2. Implement authenticated resident and administrator API access.
3. Add focused tests for transaction state transitions and duplicate UTR handling.

### Seed Compatibility Fix (2026-07-23)

* Fixed `supabase/seed.sql` for the current local Supabase version by qualifying the pgcrypto helpers as `extensions.crypt` and `extensions.gen_salt`.
* Verified with `npx supabase db reset`: migrations applied, seed data loaded, and containers restarted successfully.

### Open Decisions

* Confirm the first payment-verification source: manual admin confirmation, bank statement import, or payment gateway webhook.
* Confirm whether one resident may be assigned to multiple flats.
* Confirm the society's billing rules for partial payments, overpayments, late fees, and previous balances.
* Confirm the required receipt retention period and administrator audit-retention period.

### Decision Clarification via Technical Specification (2026-07-24)

* Re-read `Society_App_Full_Technical_Specification.md` to resolve open decisions before starting Action 2.
* **Resolved:** The API layer is not client-only. The spec requires a separate Backend API Engine (Node.js/Express or Python FastAPI/Flask) to host the database-backed extraction queue worker and the share-sheet ingestion endpoint. Node.js/Express is the chosen path since Node is already installed locally.
* **Resolved:** The first payment-verification source for the MVP is manual administrator review (Product Decisions #1 and #2 in the spec). Bank statement import and payment gateway webhook reconciliation are explicitly post-MVP (Product Decision #7).
* **Still open:** Mobile framework choice (Flutter vs React Native) — the spec lists both as options without selecting one.
* **Still open:** Whether one resident may be assigned to multiple flats — the schema's `resident_flat_assignments` table structurally supports either answer, but no business rule is stated.

### Decisions Finalized (2026-07-24, continued)

* **Mobile framework: React Native (with Expo).** Chosen because the backend is Node.js/Express and Supabase's client is JS/TS-first, keeping one language across backend, mobile, and tooling. Expo's free EAS Build satisfies the "compile to standalone APK" requirement without native Android tooling overhead. `react-native-share-menu` (already referenced in the spec) targets React Native directly.
* **Multi-house ownership and renting is supported.** A resident may own multiple houses, occupy one, and rent out others to different residents. The existing `resident_house_assignments` table already permitted one resident to hold assignments to multiple houses (no such constraint existed). Added migration `20260724100000_add_relationship_type_to_assignments.sql`:
  * Adds `relationship_type` (`'Owner'`, `'Tenant'`, `'Occupant'`) to `resident_house_assignments` so ownership and occupancy/billing responsibility can be tracked separately on the same house.
  * Adds a partial unique index on `(society_member_id, house_id) WHERE status = 'Active'` to block accidental duplicate active rows for the same person and house, while still allowing an Owner row and a Tenant row to coexist on the same house, and allowing one resident to hold active rows across many different houses.
* **Not yet run:** `npx supabase db reset` was not executed for this migration in this session (Docker was not reachable from the current shell). Run it locally to apply and verify before continuing.

### Cross-Platform Strategy: Free Android + Free iOS (2026-07-24, continued)

* Confirmed there is no scalable, genuinely free way to distribute a native binary to iOS users at large: Apple's free personal-team Xcode signing expires every 7 days and requires a physically connected Mac; unofficial sideloading tools (AltStore/Sideloadly) require each resident to run and periodically refresh their own installation. Neither scales to a whole society for free.
* **Decision:** Ship Android as a native app (Expo/React Native) using the OS share-sheet (`react-native-share-menu`) for one-tap receipt capture from UPI apps, as the spec originally designed.
* **Decision:** Ship iOS as a Progressive Web App (PWA) exported from the same Expo/React Native codebase (Expo web target). Residents install it via Safari "Add to Home Screen" — free, no Apple Developer account needed.
* **Refinement:** iOS PWA users are not limited to typing the UTR manually. Apple blocks web apps from registering as a native Share Sheet target, but the PWA can still offer a file-picker based "Upload Receipt Screenshot" action (`<input type="file" accept="image/*">`, optionally with camera capture). The uploaded image goes through the identical backend AI-extraction pipeline as Android's share-sheet submissions. Manual UTR text entry remains only the last-resort fallback (per Edge Case 3, when extraction fails on a bad image), not the primary iOS flow.
* Net effect: both platforms get full AI-assisted extraction and remain 100% free to distribute; the only difference is Android gets a one-tap OS-level share shortcut while iOS uses an in-app upload button.

### Switch to Hosted Supabase Project, No Docker (2026-07-24, continued)

* **Decision:** Development proceeds against a free hosted Supabase project instead of the local Docker stack, since Docker is blocked by disabled virtualization in BIOS on this machine. Confirmed via the Supabase CLI docs/issue tracker that `supabase link` and `supabase db push` connect directly to a remote project and do **not** require Docker; only `db diff`/`migration squash` (shadow database) need it, and those are not part of this workflow.
* Scaffolded `backend/` (Action 2 of the resume plan): Node.js/Express app with `@supabase/supabase-js`, `dotenv`, `cors`.
  * `src/config/env.js` validates required environment variables at startup and fails with a clear error if `.env` is missing values.
  * `src/config/supabaseAdmin.js` creates a service-role Supabase client for server-side-only use (queue workers, webhook handlers, admin endpoints) — never exposed to the mobile client.
  * `src/index.js` exposes `GET /` and `GET /health`; `/health` runs a real query against the `societies` table through the service-role client to prove connectivity without leaking any secret or row data.
  * `.env.example` documents `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `PORT`. `.env` is git-ignored.
* Verified locally: `npm install` succeeds, the server correctly refuses to start with a clear error when `.env` is missing, and boots cleanly with placeholder values; `/health` correctly reports `"database":"unreachable"` for a fake project URL instead of crashing — confirming the error-handling path works before real credentials exist.

#### Remaining steps to connect the hosted project (blocked on user action)

1. User creates a free project at supabase.com and shares the project ref, project URL, anon key, and service-role key.
2. Run `supabase link --project-ref <ref>` from `MyMobApp/` (no Docker required).
3. Run `supabase db push` to apply `20260724000000_initial_schema.sql` and `20260724100000_add_relationship_type_to_assignments.sql` to the hosted database.
4. Paste `supabase/seed.sql` into the hosted Studio's SQL Editor and run it once (or run via `psql <connection-string> -f supabase/seed.sql` if `psql` is available).
5. Copy `backend/.env.example` to `backend/.env` and fill in the real project URL and keys; confirm `GET /health` reports `"database":"connected"`.
6. Note: free hosted projects pause after about a week of inactivity and need a manual resume click in the Supabase dashboard.

### Hosted Project Connected and Verified (2026-07-24, continued)

* Hosted project created in the Mumbai (`ap-south-1`) region: `https://hzjnbunuinewbeaxzxhh.supabase.co`. Using the new Supabase API key format (`sb_publishable_...` for anon, `sb_secret_...` for service role) in place of the legacy JWT anon/service_role keys; `@supabase/supabase-js` accepts both transparently.
* **Network constraint discovered:** the development sandbox used in this session only permits outbound HTTPS (port 443). Raw Postgres wire-protocol connections (port 5432/6543) are blocked entirely, for any host — this affects direct connections, the IPv4 session pooler, and therefore the Supabase CLI's `db push`/`link` commands, regardless of IPv6 vs IPv4 or project region. This is a sandbox limitation, not necessarily a limitation of the user's own machine or network.
* REST/PostgREST and Auth calls (what `@supabase/supabase-js` and the backend actually use at runtime) go over HTTPS and were unaffected — the backend's `/health` check worked correctly throughout.
* **Resolution:** applied both migration files and `seed.sql` manually via the hosted project's browser-based SQL Editor (`https://supabase.com/dashboard/project/hzjnbunuinewbeaxzxhh/sql/new`), run in order: `20260724000000_initial_schema.sql`, `20260724100000_add_relationship_type_to_assignments.sql`, `seed.sql`.
* **Verified end-to-end** via the backend's service-role client: `societies` (1), `society_members` (2), `houses` (2), `resident_house_assignments` (1, with `relationship_type` correctly defaulting to `'Owner'`), `billing_periods` (2), `transactions` (0, none seeded). `backend/.env` now holds the real project URL and keys and is git-ignored.
* **Follow-up caveat:** because the migrations were applied via the SQL Editor rather than `supabase db push`, they are not recorded in the CLI's migration-history table (`supabase_migrations.schema_migrations`). If `supabase db push` is later run from a machine with unrestricted Postgres-port network access, it will try to re-apply these same migrations and fail with "already exists" errors. Fix at that time with `supabase migration repair` (mark as already applied), not a re-run.
* Action 2 (scaffold and connect the API layer) is complete and verified. Next: Action 3, authenticated resident and administrator access.

### Action 3 & 4: Authenticated Access and RLS Verification (2026-07-24, continued)

* Added to `backend/`:
  * `src/config/supabaseClient.js` — a stateless anon-key client for login/logout, and `createUserScopedClient(accessToken)`, which scopes a client to a specific user's token so all queries run under that user's RLS context (never the service-role key).
  * `src/middleware/authenticate.js` — verifies the `Authorization: Bearer <token>` header against Supabase Auth and attaches `req.user` and a token-scoped `req.supabase` to the request.
  * `src/routes/auth.js` — `POST /auth/login`, `POST /auth/logout`.
  * `src/routes/me.js` — `GET /me`: for residents, returns their own active house assignments and open billing periods; for admins/committee, returns the society's houses and billing periods. All data comes from RLS-scoped queries, not admin-bypassed ones.
* **Bug found and fixed (RLS):** first login attempt hit `"infinite recursion detected in policy for relation society_members"`. Root cause: two policies on `society_members` (`"Admins and Committee can view all society members"` and `"Admins can manage society members"`) determined admin/committee status by querying `society_members` from inside its own policy, which re-triggered the same policy indefinitely. Fixed via `20260724120000_fix_society_members_rls_recursion.sql`, which adds `SECURITY DEFINER` helper functions `is_society_admin` and `is_society_admin_or_committee` (these run as the table owner and bypass RLS internally, breaking the cycle) and rewrites both policies to call them instead of the raw recursive subquery. Applied via the hosted project's SQL Editor and verified working.
* **Bug found and fixed (app logic, not RLS):** `GET /me` initially returned every membership row RLS permitted the caller to see, which for an admin includes every member of the society - so the admin's own profile response also contained the resident's membership. RLS was behaving correctly by design (admins can list all members); the endpoint just needed its own `.eq('auth_user_id', req.user.id)` filter to return only the caller's own row(s). Fixed and reverified: admin and resident `/me` calls each now return exactly one membership.
* Added `backend/scripts/test-rls.js` (Action 4) exercising both allowed and denied paths directly against Postgres RLS (not just the app endpoints), using a resident-scoped and an admin-scoped client:
  * Resident can read the billing period for their own house; cannot read the billing period for a house they are not assigned to.
  * Resident sees only their own `society_members` row; admin sees all rows in their society.
  * Resident cannot submit a transaction for a house they are not assigned to; can submit one for their own assigned, open billing period.
  * All 6 checks passed. The one test transaction row created by the script was deleted afterward via the service-role client to keep seed data clean.
* Actions 3 and 4 from the original resume plan are now complete and verified against the real hosted project. Next: Action 5, the transaction submission slice (already partially exercised by the test script, but not yet a real endpoint) — or begin mobile app scaffolding.

### Two-Machine Workflow: Work Laptop (Agent) + Personal Laptop (Full Access), Personal Git (2026-07-24, continued)

* **Arrangement:** development happens on the work laptop with agent support; code is shared via the personal git remote below; testing that needs full/unrestricted network access (e.g. `supabase link` / `supabase db push` via the CLI) happens on the personal laptop.
* **Identity isolation:** the work laptop's *global* git config is the enterprise identity (`c-Amit-Jain_genesys` / `c.Amit.Jain@genesys.com`) and was left untouched. This repository has a **repo-local** override (`git config user.name` / `user.email`, no `--global`) set to the personal identity (`jainamit6987` / `amit.jain6987@gmail.com`); commits from this repo are authored under the personal identity only.
* **Remote:** `origin` = `https://github.com/jainamit6987/rosewoodpay.git` (HTTPS, not SSH — SSH's port 22 is expected to be blocked by the same network restriction that blocked direct Postgres connections earlier in this session; HTTPS/443 is the transport confirmed to work).
* Added a root-level `.gitignore` (secrets, `node_modules/`, Supabase local CLI state) in addition to `backend/.gitignore`.
* Initial commit `81e8b4d` pushed to `main`: progress log/spec, Supabase schema/migrations/seed, and the backend scaffold (auth, `/me`, RLS test script). `backend/.env` was correctly excluded.
* **Action items for the personal laptop (not yet done):**
  1. Clone the repo, `npm install` inside `backend/` (dependencies are not tracked by git).
  2. Recreate `backend/.env` manually (git-ignored by design) using the same Supabase project URL/keys used on the work laptop.
  3. Run `supabase link --project-ref hzjnbunuinewbeaxzxhh` (full network access should make this and `db push` work directly, unlike on the work laptop).
  4. Run `supabase migration repair` to mark the three existing migrations as already-applied before ever running `supabase db push`, since they were applied manually via the SQL Editor and are not yet in the CLI's migration-history table.
  5. Set its own repo-local git identity the same way, if the personal laptop's global git config differs (unlikely, but worth checking with `git config user.email`).
* **Discipline going forward:** `git pull` before starting work on either machine, `git commit` + `git push` before switching machines, to avoid divergent history between the two.

### Action 5: Transaction Submission Endpoint (2026-07-24, continued)

* Added `POST /transactions` (`backend/src/routes/transactions.js`), authenticated via the existing middleware, using the caller's RLS-scoped client for the actual insert:
  * Validates `house_id`, `billing_period_id`, and a positive numeric `amount` are present; requires at least one of `utr_number`, `raw_shared_payload`, or `proof_file_path`.
  * Derives `society_id` server-side from the house record (never trusted from the request body).
  * Always sets `submitted_by` from the authenticated caller (`req.user.id`), never from the request body - this applies to admin-recorded cash payments too, so the audit trail reflects who actually entered the record.
  * Leaves `processing_status` at its database default (`Submitted`) - no code path here ever marks a submission `Verified`.
  * Maps Postgres error codes to specific HTTP responses: unique-violation (duplicate UTR) to 409, foreign-key violation to 400, RLS/insufficient-privilege to 403, instead of a generic 500.
* Added `backend/scripts/test-transactions.js`, exercising the endpoint over real HTTP (not direct Supabase calls), matching the spec's Action 5 completion check exactly:
  * Unauthenticated request rejected (401).
  * Missing required fields rejected (400); missing all of UTR/payload/proof rejected (400).
  * Resident submitting for a house they are not assigned to rejected (403).
  * Resident submitting for their own assigned, open billing period succeeds (201, `processing_status: "Submitted"`).
  * Resubmitting the same UTR rejected (409).
  * Admin recording a cash payment on behalf of another house succeeds (201).
  * All 7 checks passed against the real hosted project; test rows cleaned up afterward, ledger confirmed back to 0 transactions.
* Action 5 from the original resume plan is complete and verified. Backend Actions 1-5 are now all done. Next: scaffold the `mobile/` app (Expo/React Native), which is the structural piece still missing from the repo - `backend/` and `supabase/` exist, `mobile/` does not yet.