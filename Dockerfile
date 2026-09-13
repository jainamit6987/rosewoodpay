# Builds the whole app (backend API + mobile PWA) into a single container
# image, meant for Google Cloud Run. See CLOUD_RUN_DEPLOYMENT.md for the
# full step-by-step deploy guide - this file alone is not the how-to.
#
# Two stages:
#   1. "mobile-build" - builds the Expo web bundle (mobile/dist), the same
#      artifact `npx expo export -p web` produces locally (see
#      PERSONAL_LAPTOP_SETUP_AND_TESTING.md Section 3).
#   2. "backend" - the actual runtime image: the Express API plus the
#      built web bundle from stage 1, served together same-origin, exactly
#      like backend/src/index.js already does on your laptop.
#
# No local Docker install is needed to use this - `gcloud run deploy
# --source .` uploads this repo to Google Cloud Build, which reads this
# file and builds the image entirely on Google's servers.

# ---------- Stage 1: build the mobile web bundle ----------
# Node 22 (not 20): @supabase/supabase-js's RealtimeClient hard-requires a
# native `WebSocket` global on Node < 22 (added in Node 22, missing in 20),
# and throws synchronously from createClient() without one - see the
# matching comment on the backend stage below, where this actually broke
# deploys. Using the same major version in both stages here mainly for
# consistency/cache-sharing, not because the build stage hits that issue.
FROM node:22-alpine AS mobile-build
WORKDIR /app/mobile

COPY mobile/package*.json ./
RUN npm ci

COPY mobile/ ./

# Build-time config baked into the web bundle by Expo (EXPO_PUBLIC_* vars
# are inlined into the JS bundle at build time, not read at runtime - see
# mobile/src/config/supabaseClient.js and mobile/src/api/client.js).
# These are the same values as mobile/.env. The Supabase URL/anon key are
# NOT secrets (anon key is meant to be public; real security is Supabase
# RLS - see the migration in supabase/migrations/ and the earlier chat
# about this). EXPO_PUBLIC_BACKEND_URL is deliberately left empty so the
# built app calls the API relative to whatever origin it's served from -
# this backend, same as locally.
ARG EXPO_PUBLIC_SUPABASE_URL
ARG EXPO_PUBLIC_SUPABASE_ANON_KEY
ENV EXPO_PUBLIC_SUPABASE_URL=$EXPO_PUBLIC_SUPABASE_URL
ENV EXPO_PUBLIC_SUPABASE_ANON_KEY=$EXPO_PUBLIC_SUPABASE_ANON_KEY
ENV EXPO_PUBLIC_BACKEND_URL=

RUN npx expo export -p web

# ---------- Stage 2: the backend server, serving the bundle above ----------
# Node 22, not 20 (production incident, 2026-09-13): backend/src/config/
# supabaseAdmin.js's createClient() throws synchronously - crashing the
# whole process before it ever reaches app.listen() - on Node < 22,
# because @supabase/supabase-js's RealtimeClient requires a native
# `WebSocket` global that doesn't exist until Node 22. This app never
# actually uses realtime subscriptions, but the client still initializes
# one internally by default. Confirmed via Cloud Run logs:
# "Error: Node.js detected but native WebSocket not found. Suggested
# solution: Ensure you are running Node.js 22+ ...". Worked on developer
# laptops only because their local Node was already >= 22, masking this
# until the node:20-alpine container image hit it.
FROM node:22-alpine AS backend
WORKDIR /app/backend

COPY backend/package*.json ./
RUN npm ci --omit=dev

# Only what actually runs in production - src/ (the app itself) and
# package*.json (already copied above, for the npm ci layer cache). Not
# copied: scripts/ (throwaway test-*.js/reseed-*.js scripts, dev-only,
# never invoked at runtime), .env (secrets - real ones are injected as
# Cloud Run env vars, see CLOUD_RUN_DEPLOYMENT.md), node_modules (already
# installed above by npm ci, re-copying the source tree's own copy would
# just bloat the image). Security hygiene finding (Low, 2026-09-13 audit):
# previously `COPY backend/ ./` pulled in the whole tree, scripts included,
# with no reason for any of it to exist in the runtime image at all.
COPY backend/src ./src

# backend/src/index.js looks for ../../mobile/dist relative to itself
# (i.e. /app/mobile/dist in this image) - see the comment above
# `webBuildDir` in that file.
COPY --from=mobile-build /app/mobile/dist /app/mobile/dist

# Security hygiene finding (Low, 2026-09-13 audit): the container ran as
# root the whole time, with no reason to - this process never needs to
# bind a privileged port (Cloud Run's PORT is a normal high port, 8080 by
# default) or touch anything outside /app/backend. `node` images ship a
# built-in unprivileged `node` user/group for exactly this. Ownership is
# fixed up before switching, since files were copied in as root above.
RUN chown -R node:node /app/backend
USER node

ENV NODE_ENV=production
# Cloud Run sets PORT itself (usually 8080) and expects the container to
# listen on it - backend/src/config/env.js already reads process.env.PORT,
# no code change needed.
EXPOSE 8080

CMD ["node", "src/index.js"]
