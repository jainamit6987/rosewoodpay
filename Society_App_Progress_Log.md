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

> **Superseded.** Actions 1-5 below are all complete (see the dated entries further down this log). For the current resume point, jump to **"Next Resume Action Plan (Updated 2026-07-25)"** at the end of this file.

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

### Owner/Tenant Multi-Residence Verification and Co-Assignee Visibility Fix (2026-07-25)

* **Verification requested:** confirm the schema correctly handles three real-world resident/owner scenarios: (1) a tenant pays their house while the owner never registers in the app; (2) a tenant pays their house while the owner lives elsewhere in the society in a second house they own and pays for that one themselves; (3) an owner owns multiple homes and pays for all of them.
* **Findings:** all three are structurally supported today with no schema change needed for the core mechanics:
  * Scenario 1 - `houses.owner_name` is free text; an owner never needs an account.
  * Scenario 2 and 3 - both rely on the partial unique index `unique_active_assignment_per_member_house` on `(society_member_id, house_id)` added in `20260724100000_add_relationship_type_to_assignments.sql`, which allows one house to have multiple active assignees (owner + tenant) and one member to hold multiple active house assignments. `GET /me` already aggregates correctly across multiple houses per member.
* **Gap found:** the `transactions` SELECT policy (`"Residents can view their own transactions"`, `USING (submitted_by = auth.uid())`) only let a resident see transactions they personally submitted. In scenario 2, the owner of a rented-out house had no way to see whether their tenant had paid - short of asking directly or being Admin/Committee. Decision (confirmed with the user): co-assignees of the same house should share visibility into that house's transactions.
* **Fix applied:**
  * `20260725000000_widen_transaction_visibility_to_coassignees.sql` drops and replaces that policy with one that also allows any resident with an active `resident_house_assignments` row on the transaction's `house_id` to view it, mirroring the existing `billing_periods` read policy pattern. **Must be applied manually via the hosted project's SQL Editor** (same network workaround as prior migrations - direct Postgres port access is still blocked from this environment, reverified with `Test-NetConnection` before writing this entry).
  * Added `GET /houses/:houseId/transactions` (`backend/src/routes/houses.js`, mounted in `src/index.js`) as the actual consumer of the widened policy - uses the caller's RLS-scoped client with no manual authorization check, consistent with the rest of the codebase. Returns an empty array (200), not an error, when the caller has no visibility into a house's transactions - RLS filtering silently is the expected outcome, not a failure case.
  * Extended `supabase/seed.sql` with an "Owner2 + Tenant" fixture: Owner2 owns and lives in a new house `B-102`, and also owns `R-24` (rented out); Tenant has the active `Tenant` assignment on `R-24` and is the one who actually submits `R-24`'s payment (UTR `SEEDTENANTR24PAYMENT`), so any test proving Owner2 can see it is proving co-assignee visibility, not shared submission.
  * Added `backend/scripts/test-coassignee-visibility.js`: Owner2 can see Tenant's `R-24` transaction; Tenant can see their own; the original unrelated resident (assigned only to `A-101`) cannot see it; unauthenticated requests are rejected (401); a resident can still call the endpoint for their own unrelated house and get an empty array rather than an error.
* **Follow-on gaps noted, explicitly out of scope for this fix:** nothing yet auto-closes `billing_periods.status` on transaction verification (belongs to the not-yet-built verification workflow); nothing yet flags same-billing-period duplicate submissions from different co-assignees for admin review (belongs to the future admin ledger view).
* **Still pending (blocked on manual action):** paste `20260725000000_widen_transaction_visibility_to_coassignees.sql` and the new seed.sql fixtures into the hosted project's SQL Editor, then run `node scripts/test-coassignee-visibility.js` to verify against the real project - not yet done in this session.

### Resident Contact Details: Phone Number Added (2026-07-25, continued)

* **Discussion:** the user is planning future features (notice board, meeting notifications, complaint register, visitor management) but explicitly not for the MVP. Recommended capturing `phone_number` now, since it is cheap to add today versus backfilling it across real members later, and it is the one contact detail most of those future features (especially visitor management) are likely to need. Explicitly did **not** add emergency contact, address proof, photo, or a push-notification device-token table - none of those are needed by any current or concretely-planned-next feature yet.
* **Added** `20260725010000_add_phone_number_to_society_members.sql`: nullable `phone_number VARCHAR(20)` on `society_members`, with a loose format check (`^[0-9+\-\s()]{7,20}$`) rather than a strict international-format regex. Must be applied via the hosted project's SQL Editor, same as the still-pending migration above.
* Threaded `phone_number` through `GET /me` (returned as `phoneNumber` per membership) and backfilled it for all four seeded test members in `seed.sql`.
* **Deferred, on purpose:** no self-service update path yet (a resident cannot currently change their own `phone_number` - only an Admin can, via the existing `"Admins can manage society members"` policy). Building that safely requires either column-level `GRANT`s or careful `WITH CHECK` scoping so a resident can update their own phone number without also being able to change their own `role`/`status`/`is_committee_member` - deferred until the resident onboarding/self-service flow is actually built, rather than adding partial RLS surface area now.

### Architecture Question: Custom `public` User Table vs Supabase Auth's `auth.users` (2026-07-25, continued)

* **Question raised:** since users are currently managed in the Postgres/Supabase-managed `auth.users` table, would a custom user table in the `public` schema be a better approach?
* **Decision: no change - keep `auth.users` for authentication, keep extending `public.society_members` for app/profile data.** Reasoning:
  * `auth.users` (Supabase Auth) already provides password hashing, session/JWT issuance and refresh, email verification, password reset, and future OAuth/social login for free. Replacing it with a hand-rolled table would mean reimplementing all of that - a large effort and a security liability, not a simplification.
  * RLS policies throughout the schema depend on `auth.uid()`, which only resolves against Supabase Auth's session context - a fully custom user table would break that integration and require rebuilding the authorization layer this project already has working and tested.
  * The pattern this project already follows - `auth.users` holds credentials/identity only; `public.society_members` (linked via `auth_user_id`) holds all app-specific data (role, committee flag, status, and now `phone_number`) - **is** the recommended Supabase pattern, and is effectively already "a custom public-schema table" for everything that isn't raw authentication. No architectural change needed; continue adding profile fields to `society_members` (or a future dedicated profile table if it grows large) rather than introducing a parallel user table.

### Onboarding Residents With Pre-Existing Arrears: Itemized Periods + FIFO Allocation (2026-07-25, continued)

* **Problem raised:** many real residents being onboarded already have 4-12 months of unpaid dues, and are now paying regularly without having cleared the backlog. The society's current manual process applies each new payment to the oldest unpaid month, so residents receive a receipt for an old month when they expected one for the current month - confusing, but not actually a mistake by the treasurer. Needed a decision on how the app represents and handles this, closing the "billing rules for partial payments... previous balances" item that has been on the Open Decisions list since 2026-07-23.
* **Decisions (confirmed with the user, both recommended options):**
  1. **Itemized historical periods, not a rolled-up balance.** A resident's arrears are represented as one `billing_periods` row per unpaid past month (each `status = 'Open'`, its own `amount_due`), rather than folding the whole backlog into a single current-month row via the `previous_balance` field. No schema change was needed for this - `billing_periods` already supports multiple `Open` rows per house; `previous_balance` remains available for genuine adjustments/carry-forwards later, not repurposed as a bulk-arrears bucket.
  2. **FIFO allocation, enforced server-side, not client-chosen.** Every payment is applied to the oldest still-`Open` billing period for that house. The payer never chooses which period - this makes the society's existing practice explicit and auditable instead of an unwritten treasurer convention, and the mismatch between "which month I paid" and "which month I meant" becomes visible and correct in the data, rather than confusing.
* **Implementation:**
  * `POST /transactions` ([backend/src/routes/transactions.js](backend/src/routes/transactions.js)) no longer accepts `billing_period_id` in the request body at all - this is a breaking API change, acceptable pre-launch. The server now looks up all billing periods for the given `house_id` (ordered oldest-first) through the caller's RLS-scoped client, and uses the oldest one with `status = 'Open'`. Distinct error responses: `403` if no billing periods are visible at all (not assigned, or none exist - deliberately indistinguishable to avoid leaking which), `409` if periods exist but none are `Open` (house is fully paid up).
  * `GET /me` ([backend/src/routes/me.js](backend/src/routes/me.js)) now orders `openBillingPeriods` oldest-first (so the first entry is always exactly what the next payment will resolve to) and adds a `totalOutstanding` field - the sum of `amount_due` across every open period on every assigned house, so the resident/mobile client doesn't need to sum client-side.
  * Added an "Arrears resident" fixture to `seed.sql`: `arrears@society.app`, house `C-303`, 5 monthly billing periods (4 months ago through the current month) where the oldest is already `Closed` with a `Verified` transaction against it (modeling "gradually clearing") and the remaining 4 are still `Open`.
  * Updated `scripts/test-transactions.js` for the new request contract (no `billing_period_id`) and added `scripts/test-arrears-fifo.js`, which asserts: `/me` lists open periods oldest-first, `totalOutstanding` sums correctly (8800 = 4 x 2200, excluding the Closed month), and a payment submitted with no `billing_period_id` at all resolves to the oldest Open period rather than the current month.
  * Updated `PERSONAL_LAPTOP_SETUP_AND_TESTING.md`'s Postman walkthrough and seeded-accounts/IDs tables to match (new `billing_period_id`-free request body, new test accounts/houses, new migration to repair).
  * New migration: none required for this feature (itemized periods use only existing columns/constraints) - only the already-pending `20260725000000` and now-also-pending `20260725010000` migrations still need manual application via the SQL Editor.
* **Explicitly deferred, related open decisions (not solved by this change):**
  * Whether a single payment can be split across multiple billing periods, or whether an amount that doesn't exactly match the resolved period's `amount_due` should be rejected, partially applied, or accepted as an under/overpayment - `amount` is still only validated as "a positive number," nothing more.
  * Auto-closing a `billing_periods` row when its payment is `Verified` - still entirely manual (the arrears fixture's `Closed` status was hand-set in seed data, not produced by any code path), and still belongs to the not-yet-built verification workflow.
  * Actual receipt generation/content (e.g. explicitly stating "this receipt clears March 2026" to resolve the resident-facing confusion) - no receipt endpoint exists yet at all; noted here so whoever builds it knows the period-mismatch problem needs to be addressed in the receipt text, not just the ledger.

### Structural Fix: One Transaction Can Now Cover Multiple Billing Periods (2026-07-25, continued)

* **Problem raised:** `transactions.billing_period_id` was a single FK, so one payment (one UTR) could only ever be linked to one billing period. That breaks two real cases directly raised by the arrears/FIFO work above: a resident clearing several months of arrears in one lump bank transfer, and a resident prepaying a couple of months ahead - both need one transaction to map to more than one `billing_periods` row.
* **Alternative considered and rejected:** moving `utr_number` onto `billing_periods` itself (one UTR value repeated across the periods it covers). Rejected because it would force the same UTR to appear more than once in the table, which either breaks or requires removing `unique_utr_per_society_when_not_null` - the exact constraint that exists to stop the spec's "Dual-Transaction Upload Fraud" case (the same bank transfer being claimed twice). It would also split one payment's data across two tables awkwardly, since all the processing/verification lifecycle fields (`processing_status`, `verified_by`, `extraction_confidence`, etc.) still have to live on `transactions` - `billing_periods` represents what's owed, not the state of a specific payment attempt.
* **Decision: a proper many-to-many join table.** New table `transaction_allocations` (`transaction_id`, `billing_period_id`, `amount_allocated`), and `transactions.billing_period_id` is dropped entirely (not kept as a "primary period plus extras" hybrid) - there is now exactly one path for every case, including the plain single-period one.
* **Allocation is amount-derived, not client-specified.** The client still only ever sends `{ house_id, amount, utr_number, ... }` - no period count, no period IDs. The server walks the house's `Open` billing periods oldest-first, consuming each one's own `amount_due` from the submitted total (not a flat rate - a period's amount_due can differ from another's if the rate changed between them), and auto-generates further periods via the service-role client (using `houses.default_monthly_amount`, added in the same migration) once the existing ones run out. This one mechanism now covers a normal single-month payment, a lump arrears catch-up, and an advance/prepayment, with no special-casing between them - resolving the "how do we handle advance payments" question from the previous entry at the same time.
* **Implementation:**
  * `20260725020000_add_transaction_allocations_and_default_rate.sql`: adds `houses.default_monthly_amount` (nullable, non-negative); drops the two old `transactions` INSERT policies and the `billing_period_id` column together (policies had to be dropped first - Postgres tracks policy-to-column dependencies the same way it does for views); recreates those INSERT policies without the now-impossible `billing_periods` existence check; creates `transaction_allocations` with its own SELECT policies (mirroring the co-assignee-visibility policy on `transactions` exactly, so allocation visibility never exceeds transaction visibility) and INSERT policies (this is where the "must be an open, valid period for a house I'm assigned to" check now lives, replacing what used to be enforced on `transactions.billing_period_id` directly).
  * `POST /transactions` ([backend/src/routes/transactions.js](backend/src/routes/transactions.js)) rewritten: explicitly checks for an active `resident_house_assignments` row on the house before doing anything else (previously this was inferred from whether any `billing_periods` were visible, which broke once "zero periods visible" could also legitimately mean "brand new house, nothing generated yet" - conflating the two would have let an unassigned resident trigger period generation on a house they have no claim to). Then greedily allocates the submitted amount across periods, generating new ones on demand through `supabaseAdmin` (the resident's own RLS-scoped token cannot insert into `billing_periods` - only Admins can, so this is one of the only places in the codebase that intentionally uses the service-role client on a resident-facing path, and only for this narrow, tightly-scoped purpose). Inserts the `transactions` row, then the `transaction_allocations` rows, and returns both together.
  * **Accepted gap, called out explicitly in code:** the transaction insert and the allocations insert are two separate calls, not one atomic database transaction (PostgREST does not expose multi-statement transactions over REST). If the second insert fails partway, a transaction row could end up with incomplete allocations. Moving this whole flow into a single Postgres RPC function is the correct fix, deferred until this shape is validated end-to-end.
  * `GET /houses/:houseId/transactions` ([backend/src/routes/houses.js](backend/src/routes/houses.js)) now embeds `transaction_allocations(billing_period_id, amount_allocated)` via PostgREST's FK-based embedding instead of selecting the old `billing_period_id` column.
  * Updated `supabase/seed.sql`: all four houses now have `default_monthly_amount` set; both previously-seeded transactions (the tenant's R-24 payment, the arrears resident's verified back-payment) were converted from a single `billing_period_id`-carrying insert into a `transactions` insert plus a matching `transaction_allocations` insert.
  * Updated all four test scripts for the new shape: `test-rls.js` now tests allocation-level RLS directly (insert an allocation for a period on an assigned vs. unassigned house) instead of testing period-openness via the now-gone `transactions.billing_period_id`; `test-transactions.js` and `test-arrears-fifo.js` check the new `allocations` array instead of a top-level `billing_period_id`; `test-arrears-fifo.js` gained a case submitting a lump payment covering two months' arrears in one call, asserting one transaction produces two allocation rows, oldest-first. `test-coassignee-visibility.js` needed no changes - it only ever checked `utr_number`.
  * Updated `PERSONAL_LAPTOP_SETUP_AND_TESTING.md`'s Postman walkthrough and migration-repair list for the new migration and response shape.
* **Still pending (blocked on manual action):** this is now the third migration awaiting manual application via the Supabase Dashboard SQL Editor, alongside `20260725000000` and `20260725010000` - none of the arrears/FIFO or allocation work has been verified against the live hosted project yet this session.

### Transaction Type Field + No-Partial-Month-Payments Rule (2026-07-25, continued)

* **Problem raised:** two related requests. First, nothing stopped a resident from submitting a "1.5 month" payment (some arbitrary amount that only partially covers a billing period) - the user wants Maintenance payments restricted to whole-month multiples of the house's base rate: pay for one month, two months, or more, never a fraction of one. Second, the user is planning to extend the app's scope so admins can also pay society utility bills and labour salaries through the same transaction pipeline, and wants a `transaction_type` field added now so that future work has somewhere to record it - explicitly noted that the whole-month rule should only apply to Maintenance, not to those other (not-yet-built) types.
* **Decision: gate the multiple-of-base-amount rule on a new `transaction_type` column, enforced in the application layer, not the database.** A plain `CHECK` constraint can't reference `houses.default_monthly_amount` (a different table), and `POST /transactions` is still the only insert path for this table today - the same reasoning already applied to the amount-positive/has-proof checks, which are also app-layer only. Documented as a call-out in the migration's own comment, so a future second insert path (e.g. an admin bulk-import) is a deliberate prompt to reconsider a trigger instead.
* **Decision: `transaction_type` allows `'Maintenance'` (default), `'UtilityBill'`, `'Salary'`, `'Other'`.** Only `'Maintenance'` is produced by any code path today. The other three are added now, ahead of the feature that will actually use them, purely so the column and its constraint exist and don't need a later migration just to widen an enum-like check - consistent with how `phone_number` was added ahead of visitor management earlier this session.
* **Implementation:**
  * `20260725030000_add_transaction_type_and_multiple_rule.sql`: adds `transactions.transaction_type VARCHAR(20) NOT NULL DEFAULT 'Maintenance'` with `chk_transaction_type CHECK (... IN ('Maintenance', 'UtilityBill', 'Salary', 'Other'))`, plus an index on `(society_id, transaction_type)` anticipating an admin ledger view filtered by type later. No RLS changes needed - the existing transactions/allocations policies don't reference this column.
  * `POST /transactions` ([backend/src/routes/transactions.js](backend/src/routes/transactions.js)): accepts an optional `transaction_type` in the request body (defaults to `'Maintenance'`, rejected with `400` if it's not one of the four allowed values). For `'Maintenance'` only, added a guard right after the existing house-assignment check and before any billing-period lookup: `409` if the house has no `default_monthly_amount` configured yet, `400` (with a message naming the base amount and a couple of valid example amounts) if the submitted `amount` is not a whole multiple of it. The comparison is done in integer paise (`Math.round(amount * 100) % Math.round(base * 100)`) rather than plain `%` on the raw floats, since NUMERIC-via-float values like `6600 % 2200` are not reliably exactly `0` in JS. Non-`'Maintenance'` types skip this guard entirely and fall straight into the existing FIFO allocation logic unchanged.
  * `GET /houses/:houseId/transactions` ([backend/src/routes/houses.js](backend/src/routes/houses.js)) now selects `transaction_type` alongside the existing columns, so the ledger view can distinguish payment types once it exists.
  * Added `backend/scripts/test-transaction-type-multiple-rule.js`: a 1.5x-base Maintenance payment is rejected (`400`, mentions "multiple"); omitting `transaction_type` defaults to `'Maintenance'` and a clean 1x payment still succeeds; a clean 2x-base payment succeeds with two allocation rows (even when the second month's billing period has to be auto-generated); an unrecognized `transaction_type` value is rejected (`400`); a `'UtilityBill'`-typed payment with a non-multiple amount (999) succeeds, proving the exemption. No changes needed to the other four existing test scripts - every amount they already use (2200, 2500, 4400, lump sums of whole periods) was already a clean multiple, so this is a net-new rule, not a behavior change for existing flows.
  * Updated `PERSONAL_LAPTOP_SETUP_AND_TESTING.md`'s Postman walkthrough (explained the new field/rule, added the 1.5x-amount and bad-`transaction_type` rejection cases to the table) and the migration-repair list.
* **Explicitly deferred, called out in the migration comment and in code:** `'UtilityBill'`/`'Salary'`/`'Other'` transactions still go through the exact same house-scoped, billing-period-consuming FIFO allocation as `'Maintenance'` today, because no alternate insert path exists yet - conceptually wrong for a society-wide utility bill (which isn't "owed" by a specific house's billing periods at all), but deliberately not solved now since the user only asked for the field to exist ahead of that feature, not the feature itself. When that feature is actually built, expect `house_id` to need to become optional/nullable and a separate, non-allocation code path for those types, rather than forcing them through `transaction_allocations`.
* **Known edge case, not solved:** the multiple check validates against the house's *current* `default_monthly_amount` only. If an older still-`Open` billing period's `amount_due` differs from the current rate (e.g. the rate changed since that period was created), a submitted amount that's a clean multiple of today's rate could still land as a partial allocation against that differently-priced older period once FIFO actually walks the periods - the same rate-change caveat already noted for FIFO allocation in general, not a new problem introduced here.
* **Still pending (blocked on manual action):** `20260725030000_add_transaction_type_and_multiple_rule.sql` is now a fourth migration awaiting manual application via the Supabase Dashboard SQL Editor, alongside the three from earlier today - none of today's work (visibility, phone number, allocations, or this rule) has been verified against the live hosted project yet.

## Next Resume Action Plan (Updated 2026-07-25)

The backend server was stopped at the end of this session (no `node`/`npm` process left running - confirmed, nothing to kill on resume). Start here, in order:

### Action 1: Apply the four pending migrations to the hosted project

None of these have been applied to the live hosted Supabase project (`hzjnbunuinewbeaxzxhh`) yet this session - only written and reviewed locally. Direct Postgres-port access (5432/6543) is blocked from this sandbox, so apply them the same way as all prior migrations: paste each file's contents into the hosted project's SQL Editor (`https://supabase.com/dashboard/project/hzjnbunuinewbeaxzxhh/sql/new`) and run them **in this exact order** (later ones depend on earlier ones):

1. `supabase/migrations/20260725000000_widen_transaction_visibility_to_coassignees.sql` - co-assignee (owner+tenant) transaction visibility fix.
2. `supabase/migrations/20260725010000_add_phone_number_to_society_members.sql` - adds `phone_number`.
3. `supabase/migrations/20260725020000_add_transaction_allocations_and_default_rate.sql` - the big one: drops `transactions.billing_period_id`, adds `transaction_allocations` and `houses.default_monthly_amount`. **The backend will not run correctly against the hosted DB until this one is applied** - `POST /transactions` and `GET /houses/:houseId/transactions` both already assume the new schema.
4. `supabase/migrations/20260725030000_add_transaction_type_and_multiple_rule.sql` - adds `transactions.transaction_type` (default `'Maintenance'`). **Also required before the backend will work** - `POST /transactions` already reads/writes this column unconditionally, not just when a caller sends it.

If `supabase db push` is ever run from a machine with unrestricted network access instead, run `supabase migration repair --status applied <version>` for any of these four (and all prior ones) that get "already exists" errors, rather than trying to re-run them - see the existing 2026-07-24 log entry on this same caveat.

### Action 2: Re-run seed data

`supabase/seed.sql` was substantially rewritten this session (owner2/tenant fixtures, arrears fixture, phone numbers, `default_monthly_amount`, transaction+allocation insert pairs). Paste the current `supabase/seed.sql` into the same SQL Editor and run it once the four migrations above are applied. Expect it to fail loudly if run before migration 3 (references `transaction_allocations`, which won't exist yet). It does not need any changes for migration 4 - every seeded transaction predates `transaction_type` and will correctly default to `'Maintenance'`.

### Action 3: Start the backend and run all five test scripts against the live project

* `cd backend`, confirm `.env` still has the real hosted project URL/keys, then `npm run dev` (or `node .\src\index.js`).
* Run in order, from `backend/`:
  * `node scripts/test-rls.js`
  * `node scripts/test-transactions.js`
  * `node scripts/test-arrears-fifo.js`
  * `node scripts/test-coassignee-visibility.js`
  * `node scripts/test-transaction-type-multiple-rule.js`
* None of these five scripts have been executed against the live hosted project since the allocations rewrite and the transaction-type rule were added - only reasoned about locally. Treat the first run as a real first-time verification, not a regression check. `PERSONAL_LAPTOP_SETUP_AND_TESTING.md` has the matching Postman walkthrough and the full seeded-account/ID reference table if a script fails and manual poking is needed.

**Completion check:** all five scripts report their checks passing (each prints a pass/fail summary) with zero leftover test rows in the ledger afterward.

### Open items to keep in mind after verification

* The transaction insert + allocations insert in `POST /transactions` is still two separate REST calls, not one atomic DB transaction (see the "Accepted gap" note above) - fine for now, but flagged as the right next hardening step once this shape is confirmed working end-to-end.
* No self-service `phone_number` update path yet (Admin-only via existing policy) - deferred until resident self-service onboarding is built.
* `'UtilityBill'`/`'Salary'`/`'Other'` transaction types exist as a column value but not as a real feature yet - they still go through the same house-scoped billing-period FIFO allocation as `'Maintenance'`, which won't make sense once that feature is actually designed (see the 2026-07-25 "Transaction Type Field" entry for the expected shape of that future change).
* `mobile/` (Expo/React Native) still does not exist in the repo - `backend/` and `supabase/` are the only implemented pieces so far. Once Action 3 above is green against the live project, mobile scaffolding is the next structurally-missing piece, not another backend feature.