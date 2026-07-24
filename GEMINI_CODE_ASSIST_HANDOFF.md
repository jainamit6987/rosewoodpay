# Gemini Code Assist Handoff

Use this file when continuing the Society App project with Gemini Code Assist.

## Project Context

This is a residential housing society maintenance payment app. Residents should see their society-controlled monthly charge, start a UPI payment, submit a receipt or UTR, and receive a digital record. Administrators manage residents, flats, billing periods, payment review, receipts, and ledger exports.

## Read These Files First

1. `Society_App_Full_Technical_Specification.md`
2. `Society_App_Progress_Log.md`
3. `supabase/config.toml`

The specification contains the product decisions, MVP database schema, security rules, and transaction state transition model. The progress log contains completed work, environment setup, open decisions, and next steps.

## Current Baseline

* Docker Desktop is installed and its Linux engine has been verified.
* Node.js and npm are installed.
* Supabase CLI `2.109.1` is available through `npx`.
* `supabase init` has created the local Supabase configuration.
* The first `supabase start` attempt was blocked while Docker tried to resolve `public.ecr.aws`; Windows itself could resolve and reach that registry. Docker Desktop networking may need to be refreshed before retrying.
* No production data or credentials are present in this workspace.

## First Prompt

Paste this into Gemini Code Assist Chat:

```text
You are taking over the Society App project. Read GEMINI_CODE_ASSIST_HANDOFF.md, Society_App_Full_Technical_Specification.md, Society_App_Progress_Log.md, and supabase/config.toml before making changes. Continue from the recorded state; do not redesign the product or discard existing decisions. First verify Docker registry access and local Supabase status. If the environment is ready, create the first Supabase SQL migration from Sections 7 and 8 of the specification, then validate it locally. Keep Society_App_Progress_Log.md updated after each meaningful step.
```

## Working Rules

* Preserve the distinction between receipt extraction and actual payment verification.
* Only `Verified` transactions count toward the resident ledger.
* Keep proof files private and enforce Row Level Security.
* Do not add production secrets to the repository.
* Record completed work, blockers, and the next step in `Society_App_Progress_Log.md`.