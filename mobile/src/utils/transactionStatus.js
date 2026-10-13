// Shared icon+color+label mapping for a transaction's processing_status,
// used by every screen that lists transactions (MyTransactionsScreen,
// HouseTransactionsScreen, AdminReviewScreen) - previously each screen had
// its own near-identical statusBadgeStyle/statusTextStyle/statusBadgeLabel
// trio; consolidated here once the row-level UI moved from a text badge to
// a colored icon next to the Amount (see the 2026-10-13 progress log entry
// for the UX discussion behind this change).
//
// Four distinct states, each with its own icon SHAPE (not just a color) so
// the meaning survives for a colorblind user and so the "auto-resolves via
// PaySharp" vs "waiting on a human Admin" distinction - specifically added
// in the 2026-10-10 PaySharp entry because a bare "Submitted" read as
// ambiguous - is still visible without needing to tap into the row's
// detail box, exactly as it was when that was a text badge instead.
export const TRANSACTION_STATUS = {
  verified: { icon: '\u2713', color: '#2e7d32', label: 'Verified' },
  gatewayPending: { icon: '\u26A1', color: '#8a6d00', label: 'Gateway Pending (auto, ~15 min)' },
  awaitingReview: { icon: '\u{1F553}', color: '#1a73e8', label: 'Awaiting Admin Review' },
  rejected: { icon: '\u2715', color: '#c0392b', label: 'Rejected' },
};

// Ordered for the legend strip - roughly the lifecycle a payment moves
// through (one of the two "pending" states, then settles to Verified or
// Rejected).
export const TRANSACTION_STATUS_LEGEND_ORDER = ['gatewayPending', 'awaitingReview', 'verified', 'rejected'];

// Same decision tree as every screen's own former statusBadgeStyle/
// statusBadgeLabel pair: Verified/Rejected/Failed are read straight off
// processing_status; anything else is still Submitted, split into
// "gateway, will auto-resolve" vs "self-reported, needs an Admin" purely by
// whether a PaySharp gateway order is behind it.
export function getTransactionStatusInfo(transaction) {
  const status = transaction.processing_status;
  if (status === 'Verified') return TRANSACTION_STATUS.verified;
  if (status === 'Rejected' || status === 'Failed') return TRANSACTION_STATUS.rejected;
  if (transaction.payment_gateway === 'paysharp') return TRANSACTION_STATUS.gatewayPending;
  return TRANSACTION_STATUS.awaitingReview;
}
