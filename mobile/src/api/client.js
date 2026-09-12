// Leave EXPO_PUBLIC_BACKEND_URL unset/empty to call the API relative to
// wherever this page itself was loaded from - the intended setup now that
// backend/src/index.js also serves this app's own web build (mobile/dist),
// making frontend and API same-origin. Only set it to an absolute URL
// (e.g. a LAN IP) if you're running `npx expo start --web` against a
// backend on a different host/port than the page will be served from.
const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL || '';

// Thin wrapper so every screen gets the same error shape: a plain Error
// whose message is the backend's own `{ error: "..." }` string (the same
// messages already written for Postman/manual testing in
// PERSONAL_LAPTOP_SETUP_AND_TESTING.md), not a generic "Network request
// failed" or an unhandled non-2xx response.
async function request(method, path, accessToken, body) {
  let response;
  try {
    response = await fetch(`${BACKEND_URL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        // Harmless no-op against the real backend/ngrok - only matters when
        // EXPO_PUBLIC_BACKEND_URL points at a `loca.lt` (localtunnel)
        // tunnel, which otherwise intercepts every request with an HTML
        // "are you sure you want to visit this site" reminder page instead
        // of proxying it through, breaking every fetch() call's
        // `response.json()` parse. Left in permanently since it costs
        // nothing against any other backend.
        'Bypass-Tunnel-Reminder': 'true',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (networkError) {
    throw new Error(
      `Could not reach the backend at ${BACKEND_URL}. Confirm it is running and EXPO_PUBLIC_BACKEND_URL is reachable from this device (${networkError.message}).`
    );
  }

  const json = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(json.error || `Request failed with status ${response.status}.`);
  }

  return json;
}

export function apiGet(path, accessToken) {
  return request('GET', path, accessToken);
}

export function apiPost(path, accessToken, body) {
  return request('POST', path, accessToken, body);
}

export function apiPatch(path, accessToken, body) {
  return request('PATCH', path, accessToken, body);
}
