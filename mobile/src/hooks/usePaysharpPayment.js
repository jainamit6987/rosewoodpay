import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, apiPost } from '../api/client';
import { openPaymentUrl } from '../utils/upiLinking';
import { useAuth } from '../context/AuthContext';

// Drives the "instant" PaySharp UPI Intent flow shared by SubmitPaymentScreen
// (Maintenance) and WaterChargeScreen (WaterCharge) - both otherwise-separate
// screens need the exact same sequence: create the order (POST
// /transactions/upi-intent), open whichever UPI app the resident has, then
// poll GET /transactions/:id/status until PaySharp reports a real outcome
// (or the webhook beats the poll to it - either way, the next poll tick
// picks up the already-applied result, since applyGatewayOutcome on the
// backend is idempotent).
//
// Deliberately polling, not a push/websocket - matches the backend's own
// "webhook is primary, polling is the fallback" design (see
// PAYSHARP_UPI_INTENT_INTEGRATION_PLAN.md); a resident sitting on this
// screen waiting for their own payment is exactly the case the polling
// fallback exists for.
const POLL_INTERVAL_MS = 4000;
const POLL_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes - a UPI Collect/Intent
// request itself typically expires well before this on PaySharp's side
// (see the "EXPIRED" status), so this is just an outer safety net against
// polling forever if something on the resident's end stalls out.

export function usePaysharpPayment({ accessToken, house, transactionType }) {
  // idle -> creating -> waiting (order created, UPI app just opened) ->
  // polling -> verified | rejected | timeout. 'error' can happen from
  // 'creating' (validation/503/502) or ends polling on a fatal case.
  const [state, setState] = useState('idle');
  const [error, setError] = useState(null);
  const [needsMobileNo, setNeedsMobileNo] = useState(false);
  const [transaction, setTransaction] = useState(null);

  const pollTimerRef = useRef(null);
  const pollDeadlineRef = useRef(null);

  // Suspends the app-wide inactivity auto-logout (see AuthContext.js) for
  // as long as a UPI payment is actually in flight ('waiting' - order
  // created, about to open a UPI app - through 'polling'). Opening an
  // external UPI app backgrounds this app/tab, and completing a real
  // payment there (PIN entry, bank confirmation, a slow network) can
  // easily take longer than the 5-minute inactivity window on its own -
  // that backgrounded stretch must NOT count against the resident here,
  // unlike every other reason the app might be backgrounded.
  const { pauseAutoLogout, resumeAutoLogout } = useAuth();
  const inFlight = state === 'waiting' || state === 'polling';
  useEffect(() => {
    if (!inFlight) return undefined;
    pauseAutoLogout();
    return () => resumeAutoLogout();
  }, [inFlight, pauseAutoLogout, resumeAutoLogout]);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  // Stop polling if the screen using this hook unmounts (e.g. resident
  // navigates away) - otherwise this would keep firing network calls with
  // a stale accessToken/component tree.
  useEffect(() => stopPolling, [stopPolling]);

  const checkStatusOnce = useCallback(
    async (txnId) => {
      try {
        const updated = await apiGet(`/transactions/${txnId}/status`, accessToken);
        // Merge, don't replace - GET /:id/status never returns
        // `allocations`/`intentUrl`/`gpayUrl`/`phonepeUrl` (those only ever
        // come back from the original POST /upi-intent response), so a
        // plain replace would silently drop them from what the screen has
        // to display/retry with.
        setTransaction((prev) => ({ ...prev, ...updated }));
        if (updated.processing_status === 'Verified') {
          stopPolling();
          setState('verified');
        } else if (updated.processing_status === 'Rejected') {
          stopPolling();
          setState('rejected');
        } else if (pollDeadlineRef.current && Date.now() > pollDeadlineRef.current) {
          stopPolling();
          setState('timeout');
        }
      } catch {
        // A single failed poll tick (e.g. a momentary network blip) should
        // not kill the whole flow - only the deadline does that. Covers the
        // same local-network-proxy-blocks-the-status-call case documented
        // in backend/scripts/test-paysharp-upi-intent.js - if that's what's
        // happening, every tick will fail the same way and 'timeout' is the
        // honest outcome to land on, with the resident free to just check
        // their UPI app/bank SMS directly and use "I already paid, check
        // again" once the block is lifted (different network) or the
        // webhook itself lands regardless (PaySharp calling us is
        // unaffected by anything blocking our own outbound calls).
        if (pollDeadlineRef.current && Date.now() > pollDeadlineRef.current) {
          stopPolling();
          setState('timeout');
        }
      }
    },
    [accessToken, stopPolling]
  );

  const startPolling = useCallback(
    (txnId) => {
      pollDeadlineRef.current = Date.now() + POLL_TIMEOUT_MS;
      setState('polling');
      checkStatusOnce(txnId);
      pollTimerRef.current = setInterval(() => checkStatusOnce(txnId), POLL_INTERVAL_MS);
    },
    [checkStatusOnce]
  );

  // extra: optional { customer_mobile_no } - only ever needed on a retry
  // after the backend's own 400 asking for one (see routes/transactions.js
  // - a resident with no phone_number on file yet).
  const start = useCallback(
    async (amount, extra) => {
      setError(null);
      setNeedsMobileNo(false);
      setState('creating');
      let created;
      try {
        created = await apiPost('/transactions/upi-intent', accessToken, {
          house_id: house.id,
          amount,
          ...(transactionType ? { transaction_type: transactionType } : {}),
          ...(extra || {}),
        });
      } catch (err) {
        if (/10-digit customer_mobile_no/i.test(err.message)) {
          setNeedsMobileNo(true);
        }
        setError(err.message);
        setState('error');
        return null;
      }
      setTransaction(created);
      setState('waiting');
      // Deliberately does NOT auto-open created.intentUrl (the generic
      // upi://pay?... link) here. On Android, multiple installed UPI apps
      // can all register that same generic scheme, and the OS shows its
      // own chooser - fine either way. On iOS there is no such chooser: if
      // more than one installed app claims the same custom scheme, iOS
      // just picks one on its own (silently, unpredictably) rather than
      // asking, and if nothing claims the plain "upi" scheme at all, an
      // automatic `location.href` navigation to it can surface a jarring
      // native "cannot open page" error the instant this button is
      // tapped - before the resident even sees which apps are available.
      // Showing the named-app buttons (Open Google Pay / Open PhonePe /
      // Other UPI app - see the 'waiting' UI in both screens) and letting
      // the resident make an explicit, deliberate tap avoids all of that,
      // and matches how production UPI checkout pages (Razorpay, Juspay,
      // PayU, etc.) already handle this exact ambiguity on web/iOS.
      startPolling(created.id);
      return created;
    },
    [accessToken, house.id, transactionType, startPolling]
  );

  const openSpecificApp = useCallback(async (url) => {
    if (!url) return;
    try {
      await openPaymentUrl(url);
    } catch {
      setError('Could not open that app - is it installed on this device?');
    }
  }, []);

  const checkNow = useCallback(() => {
    if (transaction?.id) checkStatusOnce(transaction.id);
  }, [transaction, checkStatusOnce]);

  const reset = useCallback(() => {
    stopPolling();
    setState('idle');
    setError(null);
    setTransaction(null);
    setNeedsMobileNo(false);
  }, [stopPolling]);

  return { state, error, needsMobileNo, transaction, start, openSpecificApp, checkNow, reset };
}
