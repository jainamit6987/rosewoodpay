import { StyleSheet, Text, View } from 'react-native';
import {
  TRANSACTION_STATUS,
  TRANSACTION_STATUS_LEGEND_ORDER,
} from '../utils/transactionStatus';

// A frozen (non-scrolling) reference strip explaining what each status icon
// means, sat above a transaction table whose own rows now show only a
// colored icon next to the Amount - no status word repeated on every row
// (see the 2026-10-13 progress log entry for the UX discussion this came
// out of). Pinning this above the scrollable row list, rather than letting
// it scroll away with row 1, is the whole point: a user who has scrolled
// deep into a long history still has it one glance away, instead of having
// to remember/scroll back up to recall what an icon meant.
//
// `statusKeys` lets a caller show only the subset of the four states that
// can actually appear in its own list - AdminReviewScreen's queue is by
// definition always Submitted, so Verified/Rejected would never show up
// there and showing them anyway would be confusing, not informative.
export default function TransactionStatusLegend({ statusKeys = TRANSACTION_STATUS_LEGEND_ORDER }) {
  return (
    <View style={styles.container}>
      {statusKeys.map((key) => {
        const status = TRANSACTION_STATUS[key];
        if (!status) return null;
        return (
          <View key={key} style={styles.item}>
            <Text style={[styles.icon, { color: status.color }]}>{status.icon}</Text>
            <Text style={styles.label}>{status.label}</Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: 14,
    rowGap: 6,
    backgroundColor: '#fff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e6e6e6',
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 10,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  icon: {
    fontSize: 13,
    fontWeight: '700',
  },
  label: {
    fontSize: 11.5,
    color: '#6e6e73',
    fontWeight: '600',
  },
});
