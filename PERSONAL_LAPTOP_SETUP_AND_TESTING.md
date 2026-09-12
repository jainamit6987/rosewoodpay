# Personal Laptop: Setup and Real-Device Testing Guide

Rewritten 2026-09-11, then **Sections 3-5 rewritten again on 2026-09-12**
once the PWA (Progressive Web App) approach was locked in as this
project's permanent direction - it's free to distribute (no app stores,
no Apple Developer account) and works the same way on both iPhone and
Android. If you did an earlier pass through this guide and got as far as
Expo Go / scanning a QR code for the Metro bundler, that step no longer
exists - see Section 3.

The previous (native Expo Go + iOS dev-client) approach is no longer the
plan. Everything below assumes: `mobile/` is built once into a static
web bundle (`npx expo export -p web`), and `backend/`'s own Express
server serves that bundle directly - so there is exactly **one** process,
one port, and (during testing) one ngrok tunnel for the whole app. No
Expo Go, no EAS builds, no native iOS/Android config at all.

This machine has no Cursor access, so everything below is meant to be
followed by hand, without an AI agent driving it.

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

**As of 2026-09-11, the entire PaySharp integration (backend + mobile) is
pushed to `main`** - `git pull` gets you everything described in this
guide. If anything below doesn't match what you see, check
`Society_App_Progress_Log.md`'s most recent entries first - that always
wins over this file.

### 1.2 Check git identity (only if this is a fresh clone)

The work laptop uses a repo-local git identity override so commits are
authored under the personal account, not the work/enterprise one. Check
what this laptop's *global* git identity already is:

```bash
git config user.email
```

If it's already your personal email, you don't need to do anything. If
not, set a repo-local override the same way (run inside the repo folder,
no `--global`):

```bash
git config user.name "Your Personal Name"
git config user.email "your-personal-email@example.com"
```

### 1.3 Install backend dependencies

`node_modules/` is not tracked by git, so this must be run on every
machine.

```bash
cd backend
npm install
```

### 1.4 Create the backend `.env` file

This file is git-ignored on purpose and will not come through `git pull`.

```bash
cp .env.example .env
```

Then edit `backend/.env`:

| Variable | Where to find it |
| :--- | :--- |
| `PORT` | `4000` (or any free port) |
| `SUPABASE_URL` | `https://hzjnbunuinewbeaxzxhh.supabase.co` |
| `SUPABASE_ANON_KEY` | Supabase Dashboard -> Settings -> API -> `sb_publishable_...` key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Dashboard -> Settings -> API -> `sb_secret_...` key (keep this one private) |
| `PAYSHARP_BASE_URL` | `https://sandbox.paysharp.co.in/external/api/v1/upi` |
| `PAYSHARP_API_TOKEN` | **Generate fresh from the PaySharp dashboard every session - sandbox tokens expire after ~1 day.** Log into `https://sandbox.paysharp.co.in/client-admin` (new password - not written down anywhere in this repo, check your password manager), go to Settings/Configuration, generate a new token. |
| `PAYSHARP_WEBHOOK_SECRET` | `4c7a55b7c0dc107496eb25a5fb7cebd85b6246eb953f24dab34ad783ba709f5c` (this one does NOT expire - reuse it, it just needs to match whatever you register in the dashboard, see Section 4) |

All three `PAYSHARP_*` variables are optional as far as the backend
booting goes - leave them unset and everything else still works, you just
can't use the Instant UPI Payment button or the webhook endpoint. See
`paysharp_sandbox_credentials.txt` (git-ignored, exists only on machines
that have run this setup before) for more detail/history on these values.

### 1.5 Applying database migrations

This project has historically applied migrations by pasting them into the
Supabase Studio SQL Editor (`https://supabase.com/dashboard/project/hzjnbunuinewbeaxzxhh/sql/new`)
rather than the CLI, because the work laptop's network blocked raw
Postgres connections. This personal laptop likely has normal outbound
access, so you're welcome to try setting up `supabase link` +
`supabase db push` properly (you'll need the project's Postgres password
from Supabase Dashboard -> Settings -> Database, and to reconcile the
CLI's migration history first with `supabase migration repair --status
applied <version>` for everything already applied - check
`Society_App_Progress_Log.md` for the full list of migration files and
which are done).

**But the simplest path, proven to work every time so far:** open the SQL
Editor link above, and for each new file under `supabase/migrations/` (in
filename/date order) that you haven't already applied, paste its contents
and run it. Check `Society_App_Progress_Log.md`'s entries for which
migrations exist and whether a given one says "applied by the user" - if
it's not mentioned as applied, it probably isn't yet.

As of 2026-09-11 the newest migration is
`20260911000000_add_paysharp_gateway_fields_to_transactions.sql` (adds the
`payment_gateway`/`paysharp_order_id`/etc. columns to `transactions`) -
**already applied** to the shared hosted project during that session, so
you should not need to re-run it, but double-check by looking at the
`transactions` table's columns in Table Editor if anything PaySharp-related
throws a "column does not exist" error.

### 1.6 Restore the seeded test fixtures (if needed)

The connected Supabase project's original test-fixture accounts
(`admin@society.app`, `resident@society.app`, etc. - see Section 2) were
at some point wiped out by a reseed with real "Rosewood Century" sample
data. If any of the logins in Section 2 fail, run:

```bash
cd backend
node scripts/reseed-test-fixtures.js
```

This is idempotent (safe to run more than once - it skips anything that
already exists) and recreates every fixture through the Supabase
service-role API directly, no SQL Editor needed for this part. It does
NOT touch or remove any of the real Rosewood Century data already there.

### 1.7 Start the backend

```bash
cd backend
npm run dev
```

You should see:

```
society-app-backend listening on http://localhost:4000
```

`npm run dev` uses `nodemon`, which auto-restarts on `.js`/`.json` file
changes - but **not** on `.env` changes. If you edit `backend/.env` (e.g.
a fresh `PAYSHARP_API_TOKEN`) while this is already running, stop it
(Ctrl+C) and start it again, or type `rs` + Enter in that terminal.

### 1.8 Sanity check

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

Useful seeded IDs (fixed by `supabase/seed.sql` /
`backend/scripts/reseed-test-fixtures.js`, same in every environment that
runs either):

| Item | ID |
| :--- | :--- |
| Society (Orchid Meadows) | `00000003-0000-0000-0000-000000000003` |
| House A-101 (assigned to the resident, `default_monthly_amount` 2200) | `00000006-0000-0000-0000-000000000006` |
| House R-24 (owned by Owner2, rented out to Tenant, 2500) | `00000007-0000-0000-0000-000000000007` |
| House B-102 (Owner2's own residence, 2000) | `0000000c-0000-0000-0000-00000000000c` |
| House C-303 (Arrears resident's house, 4 back-months + current, 2200) | `0000000f-0000-0000-0000-00000000000f` |

## 3. Mobile App (PWA - Progressive Web App)

No Expo Go, no app-store install. The mobile app is built into a plain
static website once, and that website is what you open on your phone's
browser (and optionally "Add to Home Screen" so it behaves like an
installed app - see Section 5).

### 3.1 Setup

```bash
cd mobile
npm install
cp .env.example .env
```

Edit `mobile/.env`:

| Variable | Value |
| :--- | :--- |
| `EXPO_PUBLIC_SUPABASE_URL` | Same as `backend/.env`'s `SUPABASE_URL` |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | Same as `backend/.env`'s `SUPABASE_ANON_KEY` |
| `EXPO_PUBLIC_BACKEND_URL` | **Leave this blank.** See below. |

Leave `EXPO_PUBLIC_BACKEND_URL` empty (just `EXPO_PUBLIC_BACKEND_URL=` or
delete the line) - as of 2026-09-12, `backend/src/index.js` serves this
app's own web build directly (Section 3.2), so the app and the API are
always on the exact same host/port ("same-origin"). Leaving it blank makes
the app call the API with relative paths (`/health`, `/auth/login`, ...),
which automatically works no matter what URL the whole thing ends up
being hosted at - `localhost`, your LAN IP, an ngrok URL today, or a real
domain later - with **no rebuild needed** when that URL changes. Only set
it to an absolute URL if you deliberately want the web app and the API on
two different hosts/ports.

Every variable **must** be prefixed `EXPO_PUBLIC_` to be readable at all -
Expo only inlines that prefix into the app bundle - and none of them are
secret once inlined.

### 3.2 Build the web bundle

```bash
npx expo export -p web
```

This produces a static site in `mobile/dist/` (~900KB, ~300 modules -
that's normal). **Re-run this command every time you change any code
under `mobile/src/`** - unlike Expo Go's live-reload, this is a one-shot
build, not a dev server.

### 3.3 View it

With the backend running (Section 1.7) - `backend/src/index.js` detects
`mobile/dist/` automatically and serves it at `/`:

```bash
curl http://localhost:4000/
```

Or just open `http://localhost:4000/` in a browser on this laptop. Sign
in with any seeded account from Section 2. This confirms the build works
before involving a phone at all (Section 4 covers making it reachable
from your iPhone).

## 4. Real-Device PaySharp Testing

This is the actual point of testing on this laptop - the work laptop's
Zscaler proxy blocks `GET .../order/{orderId}` (PaySharp's order-status
endpoint), so the polling fallback (`GET /transactions/:id/status`)
couldn't be fully exercised there. It should work cleanly from here.

### 4.1 Why you need ngrok (or similar) even for local testing

PaySharp needs to reach your backend over the public internet to deliver
its webhook (`POST /webhooks/paysharp`) - `localhost`/LAN IPs are not
reachable from PaySharp's servers. **ngrok** (or any similar tunnel tool)
gives your local backend a temporary public HTTPS URL.

Because `backend/src/index.js` now serves the web app itself (Section
3.2/3.3), that *same* one ngrok URL is also exactly what you open on your
iPhone - there's nothing separate to host or deploy. Your phone no longer
needs to be on the same Wi-Fi as your laptop at all (you can test over
cellular data), and there's only one URL to keep track of for everything:
the app, the API, and the webhook.

(If a QR code from an earlier attempt at this guide didn't work on your
iPhone - that was Expo Go's own Metro-bundler QR code from the
now-removed `npx expo start` step, a completely different thing from
ngrok's URL below. That whole step is gone now; ignore it.)

### 4.2 Set up ngrok

```bash
# Install (one-time): https://ngrok.com/download, or:
choco install ngrok   # if you use Chocolatey
# Sign up for a free account at ngrok.com, then:
ngrok config add-authtoken <your-token-from-the-ngrok-dashboard>
```

With the backend running on port 4000 (Section 1.7), in a separate
terminal:

```bash
ngrok http 4000
```

This prints a `Forwarding` line like:

```
Forwarding    https://abcd-1-2-3-4.ngrok-free.app -> http://localhost:4000
```

That `https://...ngrok-free.app` URL is your public backend URL for this
session - **it changes every time you restart ngrok** on the free tier,
so you'll need to redo steps 4.3/4.4 below whenever that happens.

Sanity check from any device/browser: `https://abcd-....ngrok-free.app/health`
should return the same JSON as the local `curl` check in Section 1.8.

### 4.3 Open the app through the ngrok URL

Nothing to edit - `mobile/.env`'s `EXPO_PUBLIC_BACKEND_URL` stays blank
(Section 3.1), since the app and API are same-origin. Just open the
ngrok URL itself (from 4.2) on your iPhone's Safari - that single URL
*is* the app now (served by `backend/src/index.js`'s static-serving,
Section 3.2/3.3) and the API both.

If you're re-running this after a code change, remember Section 3.2's web
build is a one-shot snapshot - `npx expo export -p web` again first, then
just refresh the ngrok URL on your phone (no restart of ngrok or the
backend needed for that part - only the static files changed).

### 4.4 Register the webhook URL in PaySharp's dashboard

Log into `https://sandbox.paysharp.co.in/client-admin` -> Settings /
Configuration -> Webhook URL, and set it to:

```
https://abcd-1-2-3-4.ngrok-free.app/webhooks/paysharp?secret=4c7a55b7c0dc107496eb25a5fb7cebd85b6246eb953f24dab34ad783ba709f5c
```

(replace the `abcd-1-2-3-4...` part with your actual ngrok URL from 4.2;
keep the `?secret=...` value exactly matching `PAYSHARP_WEBHOOK_SECRET` in
`backend/.env`). Also check whether the dashboard has a separate "retry
configuration" setting - leave it at whatever default it offers unless
you have a reason to change it.

### 4.5 Regenerate the API token if needed

PaySharp sandbox tokens expire after about a day. If `backend/.env`'s
`PAYSHARP_API_TOKEN` is more than a day old, generate a fresh one from the
same dashboard (Settings/Configuration) and update `backend/.env`, then
restart the backend (Section 1.7).

### 4.6 The actual test walkthrough

1. On your iPhone, open the ngrok URL from 4.2 in **Safari** and log in
   as `resident@society.app` / `password`. (Optional: Share -> Add to
   Home Screen first - see Section 5 - then open it from there instead.)
2. Go to Pay Maintenance (or Water Charges), enter an amount, and tap
   **"\u26A1 Instant UPI Payment"**.
3. Your phone's UPI app (Google Pay, PhonePe, etc.) should open with the
   amount and a merchant name pre-filled - this works directly from
   Safari/a home-screen PWA with no native app-store install and no dev
   client, unlike the old Expo Go path. **Read the important caveat in
   Section 4.7 before assuming the payment itself will go through.**
4. Back in the app, you'll see a "Waiting for payment confirmation..."
   screen that checks automatically every few seconds (or tap "Check now").
5. If the webhook fires (see 4.7 for how to make that happen in sandbox),
   the app should flip to "Payment confirmed" within a few seconds, and
   the underlying billing period should show as paid in the app.

### 4.7 IMPORTANT: sandbox payments likely won't complete via a real UPI app

PaySharp's sandbox environment gives your merchant account a **sandbox
merchant VPA** (visible in the intent link as the `pa=` parameter) that is
almost certainly not a real, resolvable account on the actual UPI/NPCI
network. A real, production Google Pay/PhonePe app talks to the real
banking network - it does not know about PaySharp's sandbox. So:

- **The deep link opening the right app with the right amount** - this
  IS a real, meaningful test of our own integration code, and should work.
- **Actually completing the payment inside that app** (entering your UPI
  PIN) will likely fail with something like "invalid payee" - this is
  expected, not a bug in our code, and is not something we can fix from
  the client side.

To actually get a webhook/status SUCCESS to test the rest of the flow
(auto-verify, billing period closing, etc.), use one of:
- **Check the PaySharp dashboard** for a "simulate payment" feature on the
  order you just created (their own marketing page mentions "simulate
  payments from the sandbox environment" - look for it under the order's
  own detail view once you find where sandbox orders are listed).
- **Or craft the webhook call directly yourself**, exactly like
  `backend/scripts/test-paysharp-upi-intent.js` already does successfully
  end-to-end - e.g. with `curl`:

```bash
curl -X POST "https://abcd-1-2-3-4.ngrok-free.app/webhooks/paysharp?secret=4c7a55b7c0dc107496eb25a5fb7cebd85b6246eb953f24dab34ad783ba709f5c" \
  -H "content-type: application/json" \
  -d "{\"orderId\": \"<the paysharp_order_id from the app or Table Editor>\", \"status\": \"SUCCESS\", \"amount\": 2200, \"utrNumber\": \"MANUALSIMTEST1\"}"
```

(find the real `orderId` either from the app's own waiting screen network
activity, from Supabase Studio's Table Editor on the `transactions` row
you just created, or by checking the backend's own terminal logs).

## 5. iPhone vs Android - Why PWA Removes the Platform Gap

### 5.0 Installing as a Home Screen app (optional but recommended)

Makes it open full-screen, with its own icon, no visible browser
address bar - the closest thing to "installed like a real app" without
an app store.

- **iPhone (Safari)**: open the URL, tap the **Share** icon (square with
  an up-arrow, in the bottom toolbar), scroll down, tap **"Add to Home
  Screen"**, confirm. A new icon appears on the home screen; opening it
  from there runs it standalone (no Safari chrome).
- **Android (Chrome)**: open the URL, tap the **⋮** menu (top-right),
  tap **"Add to Home screen"** (Chrome may phrase it as **"Install app"**
  if it detects a valid manifest - either works fine here), confirm.

This step is manual on both platforms (no auto-install prompt) - that's
expected, not a bug. A proper `manifest.json` + app icons (so the
installed icon/name look nicer than a generic placeholder) is a nice-to-have
not yet added to this project - not required for anything in this guide
to work.

### 5.1 Why this works the same on both platforms

This is the whole reason the PWA approach was locked in on 2026-09-12
(see `Society_App_Progress_Log.md`). The earlier native-app plan needed
a **custom Expo Dev Client build** (`eas build`, an Apple ID, ~$99/year
for real distribution beyond one device) just to get iOS to open a
`upi://...` link at all - `LSApplicationQueriesSchemes` in the native
`Info.plist` had to declare every UPI app's scheme up front, and plain
Expo Go didn't include those declarations. None of that applies to a
website.

**A webpage (or a PWA added to the Home Screen) navigating to a custom
scheme link does not require any native declaration on either platform.**
No `Info.plist` changes, no dev-client build, no Apple Developer account,
no `eas build`. That's what `openPaymentUrl()`
(`mobile/src/utils/upiLinking.js`) relies on: on web it forces a
top-level navigation (`window.open(url, '_self', ...)`, equivalent to
`location.href = url`) rather than react-native-web's own default of
`window.open(url, '_blank')` - the latter is unreliable for custom
schemes on mobile Safari/Chrome, the former is the standard, documented
way production payment gateways (Razorpay, Juspay, PayU, etc.) trigger
UPI apps from web checkout pages.

**The one real difference that remains** is app *detection*, not app
*opening*:
- **Android**: the generic `upi://pay?...` link (used for the main
  "Instant UPI Payment" button) triggers Android's own OS-level chooser
  listing every installed UPI app automatically - from a website exactly
  the same as from a native app. Nothing to code per app.
- **iPhone**: there is no web API to detect which UPI apps are installed
  at all (no `canOpenURL` equivalent exposed to web content) - this is
  why the app shows a fixed row of named buttons ("Open Google Pay",
  "Open PhonePe" - the `gpayUrl`/`phonepeUrl` fields PaySharp's own
  response already provides) rather than trying to be "smart" about
  what's installed. This is the same pattern every production UPI
  checkout page uses on iOS. Tapping a button for an app you don't have
  installed just does nothing visible (Safari silently ignores an
  unopenable custom scheme) - there's no popup for that today. Educating
  users to tap the app they actually have (as discussed) is the accepted
  approach for now; a `blur`/timeout-based "doesn't seem to have opened"
  fallback message is a possible future improvement, not yet built.

Given the sandbox-VPA limitation in Section 4.7 means the payment likely
won't complete for real on *either* platform anyway, both platforms are
now equally testable through the exact same ngrok URL, in the exact same
browser-based way, with no separate setup path for either one.

## 6. Postman Testing (backend only, no mobile app needed)

### 6.1 Create an environment

In Postman, create an environment (e.g. "Society App Local") with one
variable: `base_url` = `http://localhost:4000` (or your ngrok URL). Use
`{{base_url}}` in every request URL below.

### 6.2 Login

- **Method/URL:** `POST {{base_url}}/auth/login`
- **Body (raw JSON):** `{"email": "resident@society.app", "password": "password"}`
- **Tests tab** (auto-saves the token):
```javascript
const json = pm.response.json();
pm.environment.set("access_token", json.access_token);
```

### 6.3 Create a PaySharp intent order

- **Method/URL:** `POST {{base_url}}/transactions/upi-intent`
- **Auth:** Bearer Token, `{{access_token}}`
- **Body (raw JSON):**
```json
{
  "house_id": "00000006-0000-0000-0000-000000000006",
  "amount": 2200,
  "transaction_type": "Maintenance"
}
```
- Expect `201` with `intentUrl`/`gpayUrl`/`phonepeUrl`, `payment_gateway: "paysharp"`, `gateway_status: "PENDING"`.

### 6.4 Poll its status

- **Method/URL:** `GET {{base_url}}/transactions/{{transaction_id}}/status` (save the id from 6.3's response into an environment variable, or paste it directly)
- **Auth:** Bearer Token, `{{access_token}}`
- Expect `200`, still `PENDING`/`ON PROGRESS` until something resolves it (Section 4.7).

### 6.5 Clean up test transactions afterward

```sql
delete from transaction_allocations where transaction_id in (select id from transactions where utr_number like 'MANUALTEST%' or utr_number like 'MANUALSIMTEST%');
delete from transactions where utr_number like 'MANUALTEST%' or utr_number like 'MANUALSIMTEST%';
```

## 7. What's Already Done vs. Not Yet Built

Don't maintain a duplicate list here - it always goes stale. Check
`Society_App_Progress_Log.md`'s dated entries (newest at the bottom) for
the real, current state of the project.

## 8. Resuming / Logging

Record whatever you find while testing (bugs, questions, blockers) in
`Society_App_Progress_Log.md` under a new dated section, the same way
every other session in this project has been logged - including anything
you learn here about PaySharp's actual sandbox simulate-payment mechanism,
since that's still an open question as of 2026-09-11.
