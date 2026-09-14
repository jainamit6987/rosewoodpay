import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform, StyleSheet, View } from 'react-native';
import { supabase } from '../config/supabaseClient';

const AuthContext = createContext(null);

// Auto-logout on inactivity (2026-09-14, requested directly by the user -
// this is a payments app, so an unattended signed-in session sitting open
// is a real risk, same spirit as changePassword's re-auth-with-current-
// password comment above). User-confirmed choices: 5 minutes of
// inactivity, no "still there?" warning first (silent logout), and time
// spent backgrounded/hidden (phone locked, tab switched away) DOES count
// toward the 5 minutes - closer to a real "did the resident actually walk
// away" check than only watching foreground taps.
const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;
// How often the foreground timer re-checks the deadline while the app
// stays open and visible. Deliberately much shorter than the timeout
// itself (worst case, logout fires this long late), not a security-
// relevant value on its own - the deadline itself is what's enforced.
const INACTIVITY_CHECK_INTERVAL_MS = 15 * 1000;

export function AuthProvider({ children }) {
  // `undefined` = still checking for a persisted session on launch;
  // `null` = checked, definitely signed out. Screens use this distinction
  // to show a splash/loading state instead of flashing the login screen.
  const [session, setSession] = useState(undefined);
  const [authError, setAuthError] = useState(null);
  // Set only by the inactivity timer itself (see logout() below) - lets
  // LoginScreen show a one-time explanatory note ("you were logged out
  // due to inactivity") instead of the resident wondering why they were
  // suddenly signed out. Any OTHER logout (manual button, or a future
  // call site) passes no reason and correctly clears this back to null.
  const [logoutReason, setLogoutReason] = useState(null);

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

  const login = useCallback(async (email, password) => {
    setAuthError(null);
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setAuthError(error.message);
      return false;
    }
    setSession(data.session);
    return true;
  }, []);

  // `reason` is internal-only (currently just 'inactivity', set below).
  // Every manual logout button in the app is wired as `onLogout={logout}`
  // directly on a TouchableOpacity's onPress - which calls it with the
  // gesture's SyntheticEvent as an argument, NOT with nothing - so this
  // must whitelist the one recognized value rather than a plain
  // `reason || null`, or every manual logout would store that event
  // object as "the reason" instead of correctly clearing it to null.
  const logout = useCallback(async (reason) => {
    await supabase.auth.signOut();
    setSession(null);
    setLogoutReason(reason === 'inactivity' ? 'inactivity' : null);
  }, []);

  // Re-authenticates with the CURRENT password first, rather than trusting
  // the existing session alone as proof of identity - this app persists
  // sessions in plain AsyncStorage (see supabaseClient.js's own note), so
  // requiring the current password too is a cheap, meaningful guard against
  // someone with a few seconds of access to an unlocked/unattended device
  // silently locking the real owner out. Returns { success, error } rather
  // than throwing/setting shared authError - a password-change failure has
  // nothing to do with the LoginScreen error slot, and the caller (screen)
  // is better placed to decide how to show it.
  const changePassword = useCallback(
    async (currentPassword, newPassword) => {
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
    },
    [session]
  );

  const lastActivityRef = useRef(Date.now());
  // Counter, not a plain boolean, so it composes safely if more than one
  // thing ever needs to suspend auto-logout at once - in practice today
  // only usePaysharpPayment does (see its own comment): while a resident
  // is off in an external UPI app finishing a real payment, that's exactly
  // the kind of "backgrounded" stretch the timeout must NOT count against
  // them, unlike every other reason the app might be backgrounded.
  const pauseCountRef = useRef(0);

  const recordActivity = useCallback(() => {
    lastActivityRef.current = Date.now();
  }, []);

  const pauseAutoLogout = useCallback(() => {
    pauseCountRef.current += 1;
  }, []);

  const handleActivityCapture = useCallback(() => {
    recordActivity();
    return false; // never actually claim the responder - purely observing
  }, [recordActivity]);

  const resumeAutoLogout = useCallback(() => {
    pauseCountRef.current = Math.max(0, pauseCountRef.current - 1);
    // Coming out of a paused stretch (e.g. the resident's UPI payment just
    // resolved) counts as activity in its own right, so the fresh 5-minute
    // window starts from now rather than from whichever real tap happened
    // last before the (possibly long) paused stretch began.
    recordActivity();
  }, [recordActivity]);

  // Only tracks/enforces while actually signed in - meaningless (and
  // wasteful) to run a logout timer against the login screen itself.
  // Deliberately keyed on the signed-in/out BOUNDARY (a plain boolean),
  // not the `session` object itself - supabase-js's own autoRefreshToken
  // silently swaps in a new `session` object (same user, new token) well
  // before expiry, which would otherwise re-run this effect - and its
  // own "starting fresh" recordActivity() below - on every silent
  // refresh, quietly extending the window with no real user activity.
  const isSignedIn = Boolean(session);
  useEffect(() => {
    if (!isSignedIn) return undefined;

    recordActivity();

    const checkDeadline = () => {
      if (pauseCountRef.current > 0) return;
      if (Date.now() - lastActivityRef.current >= INACTIVITY_TIMEOUT_MS) {
        logout('inactivity');
      }
    };

    const intervalId = setInterval(checkDeadline, INACTIVITY_CHECK_INTERVAL_MS);

    // Backgrounded/hidden time counts toward the timeout (user-confirmed),
    // but a plain setInterval can't be trusted to keep firing while
    // backgrounded (mobile browsers throttle/suspend JS timers for hidden
    // tabs, and a real RN app is fully suspended) - so the deadline is
    // re-checked explicitly at the moment the app/tab becomes visible
    // again, which is reliable on both platforms regardless of what
    // happened to timers while away.
    let removeVisibilityListener;
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      const onVisibilityChange = () => {
        if (document.visibilityState !== 'visible') return;
        checkDeadline();
        if (pauseCountRef.current === 0) recordActivity();
      };
      document.addEventListener('visibilitychange', onVisibilityChange);
      removeVisibilityListener = () => document.removeEventListener('visibilitychange', onVisibilityChange);

      // Web-only: real user-input signals raw DOM listeners catch that the
      // RN touch-responder tree below (onStartShouldSetResponderCapture)
      // doesn't - typing (keydown) and pure mouse-wheel/trackpad scrolling
      // with no tap/click involved. Capture + passive so this never
      // interferes with the page's own handling of these events.
      const activityEvents = ['keydown', 'wheel', 'scroll'];
      activityEvents.forEach((evt) => document.addEventListener(evt, recordActivity, { capture: true, passive: true }));
      const removeActivityListeners = () =>
        activityEvents.forEach((evt) => document.removeEventListener(evt, recordActivity, { capture: true }));
      const removeVisibility = removeVisibilityListener;
      removeVisibilityListener = () => {
        removeVisibility();
        removeActivityListeners();
      };
    } else {
      const subscription = AppState.addEventListener('change', (nextState) => {
        if (nextState !== 'active') return;
        checkDeadline();
        if (pauseCountRef.current === 0) recordActivity();
      });
      removeVisibilityListener = () => subscription.remove();
    }

    return () => {
      clearInterval(intervalId);
      removeVisibilityListener();
    };
  }, [isSignedIn, recordActivity, logout]);

  const value = useMemo(
    () => ({
      session,
      accessToken: session?.access_token ?? null,
      isCheckingSession: session === undefined,
      isSignedIn: Boolean(session),
      authError,
      logoutReason,
      login,
      logout,
      changePassword,
      pauseAutoLogout,
      resumeAutoLogout,
    }),
    [session, authError, logoutReason, login, logout, changePassword, pauseAutoLogout, resumeAutoLogout]
  );

  return (
    <AuthContext.Provider value={value}>
      {/* Native (and web, via react-native-web's same responder system)
          tap/click/drag-start signal - observes without intercepting
          (returning false means it never actually claims the responder,
          so every screen's own touch handling is completely unaffected).
          Covers the vast majority of real interaction on both platforms;
          the web-only raw listeners above fill in the rest (typing,
          wheel-only scrolling) that this responder system doesn't see. */}
      <View style={styles.root} onStartShouldSetResponderCapture={handleActivityCapture}>
        {children}
      </View>
    </AuthContext.Provider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider.');
  }
  return context;
}
