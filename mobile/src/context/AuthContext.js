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

  const value = useMemo(
    () => ({
      session,
      accessToken: session?.access_token ?? null,
      isCheckingSession: session === undefined,
      isSignedIn: Boolean(session),
      authError,
      login,
      logout,
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
