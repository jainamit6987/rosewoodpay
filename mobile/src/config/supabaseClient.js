import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY. Copy .env.example to .env, fill in the same project values as backend/.env, and restart the Expo dev server (env vars are inlined at bundle time, not read live).'
  );
}

// The mobile app talks to Supabase Auth directly (session persistence,
// token refresh) - see the comment in backend/src/routes/auth.js, which
// only exists so this same login flow could be exercised before this app
// existed. All actual data access (billing periods, transactions) goes
// through the Express backend instead of straight PostgREST, because the
// FIFO allocation and /me aggregation logic live there, not in raw queries.
//
// AsyncStorage (unencrypted) is used for session persistence rather than
// expo-secure-store/LargeSecureStore - an accepted MVP gap, same spirit as
// the other "hardening deferred" notes throughout this project. Revisit
// before a real release; a stolen refresh token from AsyncStorage on a
// rooted/jailbroken device is a real risk for a financial app.
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});
