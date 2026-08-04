import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { supabase } from '../config/supabaseClient';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  // `undefined` = still checking for a persisted session on launch;
  // `null` = checked, definitely signed out. Screens use this distinction
  // to show a splash/loading state instead of flashing the login screen.
  const [session, setSession] = useState(undefined);
  const [authError, setAuthError] = useState(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session ?? null);
    });

    // Keeps `session` in sync with token refreshes and sign-outs that
    // happen elsewhere (e.g. a refresh token finally expiring), not just
    // the explicit login()/logout() calls below.
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
    });

    return () => subscription.subscription.unsubscribe();
  }, []);

  const login = async (email, password) => {
    setAuthError(null);
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setAuthError(error.message);
      return false;
    }
    setSession(data.session);
    return true;
  };

  const logout = async () => {
    await supabase.auth.signOut();
    setSession(null);
  };

  // Re-authenticates with the CURRENT password first, rather than trusting
  // the existing session alone as proof of identity - this app persists
  // sessions in plain AsyncStorage (see supabaseClient.js's own note), so
  // requiring the current password too is a cheap, meaningful guard against
  // someone with a few seconds of access to an unlocked/unattended device
  // silently locking the real owner out. Returns { success, error } rather
  // than throwing/setting shared authError - a password-change failure has
  // nothing to do with the LoginScreen error slot, and the caller (screen)
  // is better placed to decide how to show it.
  const changePassword = async (currentPassword, newPassword) => {
    const email = session?.user?.email;
    if (!email) {
      return { success: false, error: 'No signed-in user found.' };
    }

    const { error: reauthError } = await supabase.auth.signInWithPassword({ email, password: currentPassword });
    if (reauthError) {
      return { success: false, error: 'Current password is incorrect.' };
    }

    const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
    if (updateError) {
      return { success: false, error: updateError.message };
    }

    return { success: true };
  };

  const value = useMemo(
    () => ({
      session,
      accessToken: session?.access_token ?? null,
      isCheckingSession: session === undefined,
      isSignedIn: Boolean(session),
      authError,
      login,
      logout,
      changePassword,
    }),
    [session, authError]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider.');
  }
  return context;
}
