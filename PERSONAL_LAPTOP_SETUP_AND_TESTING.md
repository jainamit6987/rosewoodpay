# Personal Laptop: Setup and Postman Testing Guide

Use this the first time you pick up this project on the personal laptop, and
as a reference for manual Postman testing afterward. This file is safe to
commit - it contains no real secrets, only variable names and seeded
dev-only test credentials.

## 1. One-Time Setup

### 1.1 Get the code

```bash
git clone https://github.com/jainamit6987/rosewoodpay.git
cd rosewoodpay
```

If you already cloned it before, just:

```bash
git pull
```

### 1.2 Check git identity (only if this is a fresh clone)

The work laptop uses a repo-local git identity override so commits are
authored under the personal account, not the work/enterprise one. Check
what this laptop's *global* git identity already is:

```bash
git config user.email
```

If it's already your personal email, you don't need to do anything. If not,
set a repo-local override the same way (run inside the repo folder, no
`--global`):

```bash
git config user.name "Your Personal Name"
git config user.email "your-personal-email@example.com"
```

### 1.3 Install backend dependencies

`node_modules/` is not tracked by git, so this must be run on every machine.

```bash
cd backend
npm install
```

### 1.4 Create the backend `.env` file

This file is git-ignored on purpose and will not come through `git pull`.
Copy the example and fill in the real values from the Supabase dashboard
(Settings -> API for the keys, or reuse the same values already configured
in `backend/.env` on the work laptop):

```bash
cp .env.example .env
```

Then edit `backend/.env` and fill in:

| Variable | Where to find it |
| :--- | :--- |
| `SUPABASE_URL` | `https://hzjnbunuinewbeaxzxhh.supabase.co` |
| `SUPABASE_ANON_KEY` | Supabase Dashboard -> Settings -> API -> `sb_publishable_...` key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Dashboard -> Settings -> API -> `sb_secret_...` key (keep this one private) |
| `PORT` | `4000` (or any free port) |

### 1.5 (Optional) Link the Supabase CLI properly

The work laptop's network only allows outbound HTTPS, so the CLI's
`supabase link` / `supabase db push` (which need a raw Postgres connection)
could not be used there - migrations were applied manually via the Supabase
Studio SQL Editor instead. The personal laptop should have normal network
access, so the CLI can be used properly here. **Before running `db push` for
the first time**, reconcile the CLI's migration history with what has
already been applied, or it will try to re-run the existing migrations and
fail with "already exists" errors:

```bash
cd ..   # back to the repo root, where the supabase/ folder lives
supabase link --project-ref hzjnbunuinewbeaxzxhh
supabase migration repair --status applied 20260724000000
supabase migration repair --status applied 20260724100000
supabase migration repair --status applied 20260724120000
supabase migration repair --status applied 20260725000000
supabase migration repair --status applied 20260725010000
supabase migration repair --status applied 20260725020000
supabase migration repair --status applied 20260725030000
```

(Only mark a migration "applied" here if it has actually already been pasted
into the SQL Editor - check `Society_App_Progress_Log.md` for which ones are
still pending as of your last pull.)

After that, any *new* migration files can be applied normally with:

```bash
supabase db push
```

### 1.6 Start the backend

```bash
cd backend
node src/index.js
```

You should see:

```
society-app-backend listening on http://localhost:4000
```

Leave this running in its own terminal window while you test with Postman.

### 1.7 Sanity check

Open `http://localhost:4000/health` in a browser or run:

```bash
curl http://localhost:4000/health
```

Expect `{"status":"ok","database":"connected","societiesCount":1}`. If
`database` says `"unreachable"`, double check `backend/.env`.

## 2. Seeded Test Accounts (local/dev only - not real users)

| Role | Email | Password |
| :--- | :--- | :--- |
| Admin (+ Committee) | `admin@society.app` | `password` |
| Resident | `resident@society.app` | `password` |
| Owner2 (owns B-102, lives there; also owns R-24, rents it out) | `owner2@society.app` | `password` |
| Tenant (rents and pays for R-24) | `tenant@society.app` | `password` |
| Arrears resident (owns C-303, 4 months behind, 1 already cleared) | `arrears@society.app` | `password` |

Do not reuse these credentials anywhere outside this local dev project.

Useful seeded IDs (fixed by `supabase/seed.sql`, same in every environment
that runs it):

| Item | ID |
| :--- | :--- |
| House A-101 (assigned to the resident) | `00000006-0000-0000-0000-000000000006` |
| House R-24 (owned by Owner2, rented out to Tenant) | `00000007-0000-0000-0000-000000000007` |
| House B-102 (Owner2's own residence) | `0000000c-0000-0000-0000-00000000000c` |
| House C-303 (Arrears resident's house, 4 back-months + current) | `0000000f-0000-0000-0000-00000000000f` |

Billing period IDs are not fixed - look them up via the `/me` response (see
below) or the Supabase Studio Table Editor.

## 3. Postman Testing Steps

### 3.1 Create an environment

In Postman, create an environment (e.g. "Society App Local") with one
variable: `base_url` = `http://localhost:4000`. Use `{{base_url}}` in every
request URL below.

### 3.2 Login

- **Method/URL:** `POST {{base_url}}/auth/login`
- **Body (raw JSON):**
```json
{
  "email": "resident@society.app",
  "password": "password"
}
```
- **Tests tab** (auto-saves the token so you don't copy/paste it for every request):
```javascript
const json = pm.response.json();
pm.environment.set("access_token", json.access_token);
```
- Expect `200` with `access_token`, `refresh_token`, `user`.

Repeat with `admin@society.app` / `password` in a second saved request
(e.g. save the token as `admin_access_token` instead) so you can test both
roles side by side.

### 3.3 Get profile (`/me`)

- **Method/URL:** `GET {{base_url}}/me`
- **Auth:** Type "Bearer Token", value `{{access_token}}`
- Expect (as resident): your membership, `houseAssignments`, `openBillingPeriods`
  (oldest-first), and `totalOutstanding` (sum of all open periods' `amount_due`
  across every house you're assigned to). Expect (as admin): `houses` and
  `billingPeriods` for the whole society instead.

### 3.4 Submit a transaction (`/transactions`)

`billing_period_id` is **not** part of the request at all, and a single
transaction is no longer limited to one billing period either. The server
always resolves allocation itself: it walks the house's `Open` periods
oldest-first, consuming each one's own `amount_due` from the submitted
`amount`, and auto-generates further periods (using the house's
`default_monthly_amount`) if the amount covers more than currently exist -
covering a normal single-month payment, clearing several months of arrears
in one lump payment, and paying ahead of schedule, all with the same logic.
The response includes an `allocations` array showing exactly which
period(s) got how much.

`transaction_type` is an optional field, defaulting to `"Maintenance"` if
omitted. For `"Maintenance"` (the only type any real flow uses today),
`amount` **must be a whole-number multiple of the house's
`default_monthly_amount`** - e.g. 2200 or 4400 are fine, 3300 (1.5x) is
rejected outright with `400`, before any billing-period lookup happens.
`"UtilityBill"`, `"Salary"`, and `"Other"` are reserved for a future
admin-recorded society-expense feature and are exempt from that multiple
rule entirely (any positive amount is accepted) - they still go through the
same house-scoped billing-period allocation as Maintenance today, since no
alternate insert path exists yet; that's a known gap to revisit once that
feature is actually built.

- **Method/URL:** `POST {{base_url}}/transactions`
- **Auth:** Bearer Token, `{{access_token}}`
- **Body (raw JSON):**
```json
{
  "house_id": "00000006-0000-0000-0000-000000000006",
  "amount": 2200,
  "utr_number": "MANUALTEST0001"
}
```
- Expect `201` with `processing_status: "Submitted"`, `transaction_type:
  "Maintenance"`, and an `allocations` array with exactly one entry.

To see FIFO allocation pick an old month instead of the current one, log in
as `arrears@society.app` / `password` and submit against house
`0000000f-0000-0000-0000-00000000000f` (C-303) instead - that resident has
3 back-months plus the current month still `Open` (one older month is
already `Closed`), so the single allocation entry will point at a period
3 months old, not the current month.

To see one payment split across multiple periods, submit `amount: 4400`
against C-303 instead of `2200` - expect two entries in `allocations`, one
per period, each `amount_allocated: 2200`.

### 3.5 Try the rejection cases (each should fail on purpose)

| Case | Change from 3.4 | Expected status |
| :--- | :--- | :--- |
| No auth header | Remove the Bearer token | `401` |
| Missing fields | Remove `house_id` | `400` |
| No proof of any kind | Remove `utr_number` and don't add `raw_shared_payload`/`proof_file_path` | `400` |
| Wrong house | Use house `00000007-0000-0000-0000-000000000007` (R-24) while logged in as the resident | `403` |
| Duplicate UTR | Resubmit the exact same `utr_number` from a request that already succeeded | `409` |
| Partial-month amount | `amount: 3300` (1.5x the base amount) against A-101 | `400` |
| Unrecognized transaction_type | `"transaction_type": "NotARealType"` | `400` |

### 3.6 Clean up test transactions afterward

Postman submissions are not auto-deleted like the automated test scripts.
Prefix any test UTRs with something recognizable (e.g. `MANUALTEST...`) and
delete them afterward via the Supabase Studio Table Editor or SQL Editor:

```sql
delete from transactions where utr_number like 'MANUALTEST%';
```

## 4. What's Already Done vs. Not Yet Built

Done and verified (see `Society_App_Progress_Log.md` for full detail):
`GET /health`, `POST /auth/login`, `POST /auth/logout`, `GET /me`,
`POST /transactions`.

Not built yet: proof-file upload/storage handling, AI extraction queue,
admin verification/rejection endpoints, ledger export, and the mobile app
itself (`mobile/` does not exist in the repo yet).

## 5. Resuming Tomorrow

Record whatever you find while testing (bugs, questions, blockers) in
`Society_App_Progress_Log.md` under a new dated section, the same way every
other session in this project has been logged. Next planned step after this
testing pass: scaffold the `mobile/` Expo/React Native app.
