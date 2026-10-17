# Deploying to Google Cloud Run (backend + frontend, one service)

This replaces "backend running on my laptop + ngrok" with one permanent
HTTPS URL that runs in Google's cloud, free, and stays up whether or not
your laptop is on. Both the API and the PWA (the built `mobile/dist`) are
served by the same container - same as locally, see the comment above
`webBuildDir` in `backend/src/index.js`.

You do **not** need Docker installed anywhere. The `Dockerfile` at the
repo root is only read by Google's own build servers (Cloud Build) - the
`gcloud` CLI just uploads your source and tells Google to build+deploy it.

Do this once from your regular laptop (the one you already develop on).

## 0. Prerequisites

- A Google account.
- A credit/debit card on file with Google Cloud (required for account
  verification - Cloud Run's free tier below is genuinely free, you will
  not be charged for staying within it, but Google requires a card to
  create billing-enabled projects at all).
- This repo, checked out and up to date (`git pull`).

## 1. Create the Google Cloud project

1. Go to <https://console.cloud.google.com/>, sign in.
2. Accept the free trial / activate billing if prompted (again: the
   Cloud Run usage this app needs will fall inside the **Always Free**
   monthly quota - 2,000,000 requests, 180,000 vCPU-seconds, 360,000
   GiB-seconds per month - not the time-limited trial credit).
3. Click the project dropdown (top bar) → **New Project**. Name it e.g.
   `rosewood-society-app`. Create it, then make sure it's selected.

## 2. Install and set up the `gcloud` CLI

1. Download/install from
   <https://cloud.google.com/sdk/docs/install> (Windows installer, plain
   next-next-finish - no Docker involved).
2. Open a **new** PowerShell window (so it picks up the updated PATH) and
   run:

```powershell
gcloud init
```

Follow the prompts: log in via the browser window it opens, then pick the
`rosewood-society-app` project you created above.

3. Enable the APIs this needs (one-time):

```powershell
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com
```

## 2a. Running two environments (dev/sandbox + production)

If you keep a separate dev/sandbox project alongside the production one
(recommended - that's what the new project created on 2026-10-18 is for),
don't just repeatedly run `gcloud config set project <id>` by hand before
every command - it's easy to forget which one you're pointed at and
accidentally deploy or create secrets in the wrong project. Use named
**configurations** instead - the CLI's own built-in profile switcher:

```powershell
# One-time setup - create a named profile for each project
gcloud config configurations create dev
gcloud config set project <your-dev-project-id>
gcloud config set run/region asia-south1

gcloud config configurations create prod
gcloud config set project <your-prod-project-id>
gcloud config set run/region asia-south1

# Day to day - switch which project every following command targets
gcloud config configurations activate dev
gcloud config configurations activate prod

# Always double check before anything sensitive (deploy, secrets create)
gcloud config configurations list
```

The active configuration's `*` marker and project ID also show up in the
output of plain `gcloud config list` - get in the habit of running that
once before any `gcloud run deploy` or `gcloud secrets create` command if
there's ever a doubt which project is active.

## 3. Pick a region

Use `asia-south1` (Mumbai) - lowest latency for residents in India. You
can change this later without losing anything; it's just a `--region`
flag.

## 4. First deploy

### 4a. Create the 3 real secrets in Secret Manager (one-time per project)

Three of the six backend values are genuine secrets (`SUPABASE_SERVICE_ROLE_KEY`,
`PAYSHARP_API_TOKEN`, `PAYSHARP_WEBHOOK_SECRET`) and go into **Secret
Manager** instead of a plain env var, so their real values never appear in
the deploy command, your shell history, or Cloud Run's own request/deploy
logs - only a name+version *reference* does. Easiest from the Console:

1. Console → **Secret Manager** → **Create Secret**.
2. Name it `supabase-service-role-key`, paste the real value from
   `backend/.env` into the "Secret value" box, leave replication on
   Automatic → **Create Secret**.
3. Repeat for `paysharp-api-token` and `paysharp-webhook-secret`.

(Or via CLI, piping the value through stdin so it never appears as a
command-line argument: `"<value>" | gcloud secrets create supabase-service-role-key --data-file=-`.)

The other three values (`SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`PAYSHARP_BASE_URL`) are not sensitive - they're meant to be public
(the anon key is designed to be exposed to clients; see
`mobile/.env.production` below) - so they stay plain `--set-env-vars`.

### 4b. Deploy

From the repo root (`D:\Users\amjain\Downloads\MyMobApp`), as a single
line (avoid PowerShell's `` ` `` line-continuation for this - a stray
trailing space after any `` ` `` silently breaks the command):

```powershell
gcloud run deploy society-app --source . --region asia-south1 --allow-unauthenticated --set-env-vars "SUPABASE_URL=<copy from backend/.env>,SUPABASE_ANON_KEY=<copy from backend/.env>,PAYSHARP_BASE_URL=<copy from backend/.env>" --set-secrets "SUPABASE_SERVICE_ROLE_KEY=supabase-service-role-key:latest,PAYSHARP_API_TOKEN=paysharp-api-token:latest,PAYSHARP_WEBHOOK_SECRET=paysharp-webhook-secret:latest"
```

> **Do not paste real key values into this doc or any other file that
> gets committed to git** other than `mobile/.env.production` (see
> below - those two values are the deliberate exception). Copy each
> `--set-env-vars` value straight from your local `backend/.env` directly
> into the PowerShell command when you run it. This doc itself is meant
> to be committed, so it only ever shows placeholders for these. The
> `--set-secrets` portion above never contains a real value at all - just
> secret *names*, which are not sensitive and safe to leave exactly as
> written.

A few notes on that command:

- `--source .` is what triggers the "no local Docker" path - it zips the
  repo (minus everything in `.dockerignore`) and has Cloud Build build the
  image from the `Dockerfile` remotely.
- `--allow-unauthenticated` makes the URL publicly reachable (residents
  don't have Google accounts to log in with - your app's own Supabase
  auth is the real login).
- There is **no `--build-env-vars-file` flag here** (production incident,
  2026-09-13: that flag is buildpacks-only and is silently ignored
  whenever a Dockerfile is present, which it is here - it looked like it
  worked because gcloud still records the values as metadata, but the
  web bundle actually shipped with an empty Supabase URL/key and crashed
  on load). The two **build-time** values baked into the web bundle
  (`EXPO_PUBLIC_SUPABASE_URL`/`EXPO_PUBLIC_SUPABASE_ANON_KEY`) instead
  come from the committed `mobile/.env.production` file, which Expo CLI
  loads automatically during the `Dockerfile`'s `npx expo export -p web`
  step - see the comments in both `mobile/.env.production` and the
  `Dockerfile` for the full explanation. Committing that specific file is
  intentional and safe (the anon key is meant to be public); if you ever
  rotate the Supabase project, update `mobile/.env.production` to match
  `mobile/.env` by hand and redeploy.

The first deploy takes a few minutes (building both stages). When it
finishes, it prints a **Service URL** like:

```
https://society-app-xxxxxxxxxx-el.a.run.app
```

That's your permanent app URL. Open it on your phone - it's the exact
same PWA, just no longer tied to your laptop.

## 5. Point PaySharp's webhook at the new URL

In the PaySharp dashboard's Webhook Configuration page (2026-10-17: this
turned out to offer a real "Bearer Auth" option, not just a bare query
param - use it, since Cloud Run's own request logs capture full query
strings by default but not headers):

- Webhook URL: `https://society-app-xxxxxxxxxx-el.a.run.app/webhooks/paysharp`
  (no `?secret=...` suffix needed with Bearer Auth)
- Auth Type: **Bearer Auth**
- Token: your `PAYSHARP_WEBHOOK_SECRET` value
- Trigger: **All Cases** (not Success-only - the backend also auto-rejects
  on FAILED/EXPIRED; Success-only would silently lose that fast path)

(`routes/paysharpWebhook.js` still accepts the old `?secret=...` query
param too, purely so an already-registered sandbox webhook using that form
keeps working untouched - switch sandbox over to Bearer Auth the same way
whenever convenient.) This replaces the ngrok URL - no more re-registering
a new URL every session.

## 6. Redeploying after future code changes

Same one command, every time:

```powershell
gcloud run deploy society-app --source . --region asia-south1
```

(Cloud Run reuses the env vars/secrets you already set unless you pass
`--set-env-vars`/`--set-secrets` again with new values. If you ever
rotate one of the 3 real secrets, add a new version with
`gcloud secrets versions add <secret-name> --data-file=-` - the `:latest`
reference in the deploy command already picks up the newest version on
the next deploy, no command change needed.)

## 7. Verify

- `https://<your-url>/health` should return `{"status":"ok","database":"connected",...}`.
- Load the root URL on a phone that has never touched this project before
  - that's the real test of "does this work independent of my laptop."

## 8. Optional hardening (do this after the first successful deploy, not before)

- Consider Cloud Run's `--min-instances=1` only if the ~1-3s cold start
  after idle ever bothers testers - it keeps one instance always warm,
  but at a small cost against the free quota. Leave it at the default (0)
  for now since the whole point right now is $0 cost.
