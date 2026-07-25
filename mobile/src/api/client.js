const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL;

if (!BACKEND_URL) {
  throw new Error(
    'Missing EXPO_PUBLIC_BACKEND_URL. Copy .env.example to .env, point it at your running backend, and restart the Expo dev server.'
  );
}

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
