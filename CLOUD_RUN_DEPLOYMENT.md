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
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
```

## 3. Pick a region

Use `asia-south1` (Mumbai) - lowest latency for residents in India. You
can change this later without losing anything; it's just a `--region`
flag.

## 4. First deploy

From the repo root (`D:\Users\amjain\Downloads\MyMobApp`):

```powershell
gcloud run deploy society-app `
  --source . `
  --region asia-south1 `
  --allow-unauthenticated `
  --build-env-vars-file cloudbuild-env.yaml `
  --set-env-vars "SUPABASE_URL=<copy from backend/.env>,SUPABASE_ANON_KEY=<copy from backend/.env>,SUPABASE_SERVICE_ROLE_KEY=<copy from backend/.env>,PAYSHARP_BASE_URL=<copy from backend/.env>,PAYSHARP_API_TOKEN=<copy from backend/.env>,PAYSHARP_WEBHOOK_SECRET=<copy from backend/.env>"
```

> **Do not paste real key values into this file or any other file that
> gets committed to git.** Copy each value straight from your local
> `backend/.env` directly into the PowerShell command when you run it
> (or into a throwaway local file that's already covered by
> `.gitignore`'s `*.env` rule, e.g. `deploy-env-vars.txt`). This doc
> itself is meant to be committed, so it only ever shows placeholders.

A few notes on that command:

- `--source .` is what triggers the "no local Docker" path - it zips the
  repo (minus everything in `.dockerignore`) and has Cloud Build build the
  image from the `Dockerfile` remotely.
- `--allow-unauthenticated` makes the URL publicly reachable (residents
  don't have Google accounts to log in with - your app's own Supabase
  auth is the real login).
- You still need a small `cloudbuild-env.yaml` file for the two
  **build-time** (not runtime) values baked into the web bundle - create
  it next to this file (same rule: real values go in your local copy,
  never committed - `cloudbuild-env.yaml` is already covered by nothing
  in `.gitignore` today, so also add it there before creating it):

```yaml
EXPO_PUBLIC_SUPABASE_URL: "<copy from mobile/.env>"
EXPO_PUBLIC_SUPABASE_ANON_KEY: "<copy from mobile/.env>"
```

  (These two happen to not be secret - the anon key is meant to be
  public - but keeping the habit of "no real values in committed files"
  consistent everywhere is simpler than remembering exceptions. Do not
  put `SUPABASE_SERVICE_ROLE_KEY` or any `PAYSHARP_*` value in this file,
  only the two `EXPO_PUBLIC_*` ones above.)

The first deploy takes a few minutes (building both stages). When it
finishes, it prints a **Service URL** like:

```
https://society-app-xxxxxxxxxx-el.a.run.app
```

That's your permanent app URL. Open it on your phone - it's the exact
same PWA, just no longer tied to your laptop.

## 5. Point PaySharp's webhook at the new URL

In the PaySharp sandbox dashboard, update the webhook URL to:

```
https://society-app-xxxxxxxxxx-el.a.run.app/webhooks/paysharp?secret=<your PAYSHARP_WEBHOOK_SECRET value>
```

(same `secret` value you set as `PAYSHARP_WEBHOOK_SECRET` above). This
replaces the ngrok URL - no more re-registering a new URL every session.

## 6. Redeploying after future code changes

Same one command, every time:

```powershell
gcloud run deploy society-app --source . --region asia-south1
```

(Cloud Run reuses the env vars/secrets you already set unless you pass
`--set-env-vars` again with new values.)

## 7. Verify

- `https://<your-url>/health` should return `{"status":"ok","database":"connected",...}`.
- Load the root URL on a phone that has never touched this project before
  - that's the real test of "does this work independent of my laptop."

## 8. Optional hardening (do this after the first successful deploy, not before)

- Move `SUPABASE_SERVICE_ROLE_KEY`, `PAYSHARP_API_TOKEN`, and
  `PAYSHARP_WEBHOOK_SECRET` into **Secret Manager** instead of plain
  `--set-env-vars` (also free at this scale - 6 active secret versions
  and 10,000 access operations/month included). Ask me when you're ready
  and I'll walk through it - it's a few extra `gcloud` commands, not a
  code change.
- Consider Cloud Run's `--min-instances=1` only if the ~1-3s cold start
  after idle ever bothers testers - it keeps one instance always warm,
  but at a small cost against the free quota. Leave it at the default (0)
  for now since the whole point right now is $0 cost.
