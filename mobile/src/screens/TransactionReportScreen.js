import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import DateField from '../components/DateField';
import { apiGet } from '../api/client';
import { useAuth } from '../context/AuthContext';

function formatMoney(amount) {
  return `\u20B9${Number(amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
}

function formatDate(value) {
  if (!value) return '\u2014';
  return new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

// Kept in sync with routes/society.js's own PAYMENT_MODES list (see
// RecordExpenseScreen's identical lookup) - also doubles as the Payment
// Mode filter chips below, since the report only ever reads payment_mode
// back, never writes it.
const PAYMENT_MODES = [
  { value: 'UPI', label: 'UPI' },
  { value: 'Cash', label: 'Cash' },
  { value: 'NEFT_IMPS', label: 'NEFT/IMPS' },
  { value: 'Cheque', label: 'Cheque' },
];

const PAYMENT_MODE_LABELS = Object.fromEntries(PAYMENT_MODES.map((mode) => [mode.value, mode.label]));

function formatPaymentMode(mode) {
  return PAYMENT_MODE_LABELS[mode] || mode;
}

// Same local-components-not-toISOString reasoning as DateField.web.js's
// own toInputValue - avoids the UTC rollback that would otherwise send the
// wrong calendar day for anyone west of UTC.
function toDateOnly(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function endOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

function rangeLabel(fromDate, toDate) {
  const opts = { day: 'numeric', month: 'short', year: 'numeric' };
  return `${fromDate.toLocaleDateString(undefined, opts)} \u2013 ${toDate.toLocaleDateString(undefined, opts)}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Builds the literal HTML table the export/share button turns into a PDF -
// same hidden-iframe-on-web / expo-print-on-native split as
// PendencyReportScreen's own buildReportHtml, same column order as the
// on-screen table below (Txn Date, UTR/Ref No., Mode, Cr/Dr, Amount,
// Description).
function buildReportHtml({ societyName, rangeText, modeText, rows, totalCr, totalDr }) {
  const tableRows = rows
    .map(
      (row) => `
        <tr>
          <td>${escapeHtml(formatDate(row.txn_date))}</td>
          <td>${escapeHtml(row.utr_number || '\u2014')}</td>
          <td>${escapeHtml(formatPaymentMode(row.payment_mode))}</td>
          <td>${escapeHtml(row.direction)}</td>
          <td class="num">${escapeHtml(formatMoney(row.amount))}</td>
          <td>${escapeHtml(row.description)}</td>
        </tr>`
    )
    .join('');

  return `
    <html>
      <head>
        <meta charset="utf-8" />
        <style>
          body { font-family: -apple-system, Helvetica, Arial, sans-serif; color: #1c1c1e; padding: 24px; }
          h1 { font-size: 20px; margin-bottom: 2px; }
          .subtitle { font-size: 13px; color: #6e6e73; margin-bottom: 18px; }
          table { width: 100%; border-collapse: collapse; font-size: 12px; }
          th, td { border: 1px solid #d8d8dc; padding: 8px 10px; text-align: left; }
          th { background-color: #f5f5f7; font-weight: 700; }
          td.num, th.num { text-align: right; }
          tfoot td { font-weight: 700; background-color: #f5f5f7; }
        </style>
      </head>
      <body>
        <h1>${escapeHtml(societyName)} \u2013 Transaction Report</h1>
        <div class="subtitle">${escapeHtml(rangeText)}${modeText ? ` \u2022 ${escapeHtml(modeText)}` : ''} \u2022 ${rows.length} transaction${rows.length === 1 ? '' : 's'}</div>
        <table>
          <thead>
            <tr>
              <th>Txn Date</th>
              <th>UTR / Ref No.</th>
              <th>Mode</th>
              <th>Cr / Dr</th>
              <th class="num">Amount</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>${tableRows}</tbody>
          <tfoot>
            <tr>
              <td colspan="4">Total Cr / Total Dr</td>
              <td class="num">${escapeHtml(formatMoney(totalCr))} / ${escapeHtml(formatMoney(totalDr))}</td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </body>
    </html>
  `;
}

// Admin/Committee "view transaction report at society level" - a flat,
// whole-society ledger for a custom date range, backed by
// GET /society/:id/transaction-report?from=&to=&mode=. Every Verified
// transaction either direction: Cr (a resident's Maintenance or
// WaterCharge payment, money in) or Dr (a society expense -
// Salary/UtilityBill/Other, money out). Launched from within a society's
// own card on SocietyScreen, same shape as PendencyReportScreen (both are
// whole-society reports, not scoped to one house).
//
// Defaults to the current calendar month (same default the backend itself
// falls back to when no filter is given at all), but From/To are freely
// editable beyond that - "filter by dates" is a real from/to range here,
// not just a month picker. Payment Mode is a separate, independent filter
// that ANDs with whatever date range is in effect ("All" clears it).
export default function TransactionReportScreen({ society, onBack }) {
  const { accessToken } = useAuth();
  const [fromDate, setFromDate] = useState(() => startOfMonth(new Date()));
  const [toDate, setToDate] = useState(() => endOfMonth(new Date()));
  const [paymentMode, setPaymentMode] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    try {
      setError(null);
      const params = new URLSearchParams({ from: toDateOnly(fromDate), to: toDateOnly(toDate) });
      if (paymentMode) params.set('mode', paymentMode);
      const data = await apiGet(`/society/${society.id}/transaction-report?${params.toString()}`, accessToken);
      setTransactions(data.transactions || []);
    } catch (err) {
      setError(err.message);
    }
  }, [accessToken, society.id, fromDate, toDate, paymentMode]);

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const resetToCurrentMonth = () => {
    const now = new Date();
    setFromDate(startOfMonth(now));
    setToDate(endOfMonth(now));
  };

  const isCurrentMonth = useMemo(() => {
    const now = new Date();
    return (
      toDateOnly(fromDate) === toDateOnly(startOfMonth(now)) && toDateOnly(toDate) === toDateOnly(endOfMonth(now))
    );
  }, [fromDate, toDate]);

  const { totalCr, totalDr } = useMemo(() => {
    let cr = 0;
    let dr = 0;
    for (const txn of transactions) {
      if (txn.direction === 'Cr') cr += Number(txn.amount);
      else dr += Number(txn.amount);
    }
    return { totalCr: cr, totalDr: dr };
  }, [transactions]);

  const handleExport = async () => {
    setExporting(true);
    try {
      const html = buildReportHtml({
        societyName: society.name,
        rangeText: rangeLabel(fromDate, toDate),
        modeText: paymentMode ? formatPaymentMode(paymentMode) : null,
        rows: transactions,
        totalCr,
        totalDr,
      });
      if (Platform.OS === 'web') {
        // Same hidden-iframe print technique as PendencyReportScreen's own
        // handleExport - see that screen's comment for the full reasoning
        // on why this replaced two earlier, unreliable approaches.
        const iframe = document.createElement('iframe');
        iframe.style.position = 'fixed';
        iframe.style.right = '0';
        iframe.style.bottom = '0';
        iframe.style.width = '0';
        iframe.style.height = '0';
        iframe.style.border = '0';
        iframe.setAttribute('aria-hidden', 'true');
        const cleanup = () => {
          if (iframe.parentNode) {
            iframe.parentNode.removeChild(iframe);
          }
        };
        document.body.appendChild(iframe);
        iframe.onload = () => {
          try {
            iframe.contentWindow.focus();
            iframe.contentWindow.print();
          } catch (err) {
            cleanup();
            Alert.alert('Export failed', 'Unable to open the print dialog. Please try again.');
            return;
          }
          iframe.contentWindow.addEventListener('afterprint', cleanup);
          setTimeout(cleanup, 5 * 60 * 1000);
        };
        iframe.srcdoc = html;
      } else {
        const { uri } = await Print.printToFileAsync({ html });
        const canShare = await Sharing.isAvailableAsync();
        if (canShare) {
          await Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle: 'Share transaction report' });
        } else {
          Alert.alert('PDF ready', `Saved to ${uri}`);
        }
      }
    } catch (err) {
      Alert.alert('Export failed', err.message);
    } finally {
      setExporting(false);
    }
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
    >
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Transaction Report</Text>
          <Text style={styles.subtitle}>{society.name}</Text>
        </View>
        {onBack ? (
          <TouchableOpacity onPress={onBack}>
            <Text style={styles.backLink}>Back</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      <View style={styles.filterCard}>
        <View style={styles.dateRow}>
          <View style={styles.dateField}>
            <Text style={styles.filterLabel}>From</Text>
            <DateField value={fromDate} onChange={setFromDate} maximumDate={toDate} />
          </View>
          <View style={styles.dateField}>
            <Text style={styles.filterLabel}>To</Text>
            <DateField value={toDate} onChange={setToDate} minimumDate={fromDate} maximumDate={new Date()} />
          </View>
        </View>
        {!isCurrentMonth ? (
          <TouchableOpacity onPress={resetToCurrentMonth}>
            <Text style={styles.monthResetLink}>Reset to current month</Text>
          </TouchableOpacity>
        ) : null}

        <Text style={[styles.filterLabel, styles.paymentModeLabel]}>Payment Mode</Text>
        <View style={styles.chipRow}>
          <TouchableOpacity
            style={[styles.chip, paymentMode === null && styles.chipActive]}
            onPress={() => setPaymentMode(null)}
          >
            <Text style={[styles.chipText, paymentMode === null && styles.chipTextActive]}>All</Text>
          </TouchableOpacity>
          {PAYMENT_MODES.map((mode) => (
            <TouchableOpacity
              key={mode.value}
              style={[styles.chip, paymentMode === mode.value && styles.chipActive]}
              onPress={() => setPaymentMode(mode.value)}
            >
              <Text style={[styles.chipText, paymentMode === mode.value && styles.chipTextActive]}>{mode.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" />
        </View>
      ) : error ? (
        <View style={styles.centered}>
          <Text style={styles.error}>{error}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={handleRefresh}>
            <Text style={styles.retryButtonText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
          <View style={styles.summaryCard}>
            <View>
              <Text style={styles.summaryValueCr}>{formatMoney(totalCr)}</Text>
              <Text style={styles.summaryLabel}>total Cr (maintenance/water)</Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={styles.summaryValueDr}>{formatMoney(totalDr)}</Text>
              <Text style={styles.summaryLabel}>total Dr (expenses)</Text>
            </View>
          </View>

          <TouchableOpacity
            style={[styles.exportButton, (exporting || transactions.length === 0) && styles.exportButtonDisabled]}
            onPress={handleExport}
            disabled={exporting || transactions.length === 0}
          >
            {exporting ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.exportButtonText}>Export as PDF / Share</Text>
            )}
          </TouchableOpacity>
          {Platform.OS === 'web' && transactions.length > 0 ? (
            <Text style={styles.exportHint}>
              A print preview will open in a new tab - choose "Save as PDF" as the destination there to download it.
            </Text>
          ) : null}

          {transactions.length === 0 ? (
            <Text style={styles.empty}>No transactions recorded for {rangeLabel(fromDate, toDate)}.</Text>
          ) : (
            // Same column order as the PDF export - Txn Date, UTR/Ref No.,
            // Mode, Cr/Dr, Amount, Description - wrapped in its own
            // horizontal ScrollView, same reasoning as PendencyReportScreen's
            // own table (6 columns of real data does not fit a phone-width
            // screen).
            <ScrollView horizontal showsHorizontalScrollIndicator style={styles.tableScroll}>
              <View style={styles.table}>
                <View style={[styles.tableRow, styles.tableHeaderRow]}>
                  <Text style={[styles.tableCell, styles.tableHeaderText, styles.colDate]}>Txn Date</Text>
                  <Text style={[styles.tableCell, styles.tableHeaderText, styles.colRef]}>UTR / Ref No.</Text>
                  <Text style={[styles.tableCell, styles.tableHeaderText, styles.colMode]}>Mode</Text>
                  <Text style={[styles.tableCell, styles.tableHeaderText, styles.colDirection]}>Cr / Dr</Text>
                  <Text style={[styles.tableCell, styles.tableHeaderText, styles.colAmount]}>Amount</Text>
                  <Text style={[styles.tableCell, styles.tableHeaderText, styles.colDescription]}>Description</Text>
                </View>

                {transactions.map((txn, index) => (
                  <View key={txn.id} style={[styles.tableRow, index % 2 === 1 ? styles.tableRowAlt : null]}>
                    <Text style={[styles.tableCell, styles.colDate]}>{formatDate(txn.txn_date)}</Text>
                    <Text style={[styles.tableCell, styles.colRef]}>{txn.utr_number || '\u2014'}</Text>
                    <Text style={[styles.tableCell, styles.colMode]}>{formatPaymentMode(txn.payment_mode)}</Text>
                    <Text
                      style={[
                        styles.tableCell,
                        styles.colDirection,
                        styles.cellBold,
                        txn.direction === 'Cr' ? styles.cellCr : styles.cellDr,
                      ]}
                    >
                      {txn.direction}
                    </Text>
                    <Text
                      style={[
                        styles.tableCell,
                        styles.colAmount,
                        txn.direction === 'Cr' ? styles.cellCr : styles.cellDr,
                      ]}
                    >
                      {formatMoney(txn.amount)}
                    </Text>
                    <Text style={[styles.tableCell, styles.colDescription]}>{txn.description}</Text>
                  </View>
                ))}

                <View style={[styles.tableRow, styles.tableFooterRow]}>
                  <Text style={[styles.tableCell, styles.colDate, styles.cellBold]}>Total</Text>
                  <View style={[styles.tableCell, styles.colRef]} />
                  <View style={[styles.tableCell, styles.colMode]} />
                  <View style={[styles.tableCell, styles.colDirection]} />
                  <View style={[styles.tableCell, styles.colAmount]}>
                    <Text style={[styles.cellBold, styles.cellCr]}>{formatMoney(totalCr)}</Text>
                    <Text style={[styles.cellBold, styles.cellDr]}>{formatMoney(totalDr)}</Text>
                  </View>
                  <View style={[styles.tableCell, styles.colDescription]} />
                </View>
              </View>
            </ScrollView>
          )}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f7',
  },
  content: {
    padding: 16,
    paddingTop: 48,
    paddingBottom: 40,
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    gap: 16,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 16,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: '#1c1c1e',
  },
  subtitle: {
    fontSize: 14,
    color: '#6e6e73',
    marginTop: 4,
  },
  backLink: {
    color: '#1a73e8',
    fontSize: 14,
    fontWeight: '600',
    paddingTop: 4,
  },
  filterCard: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 16,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  dateRow: {
    flexDirection: 'row',
    gap: 12,
  },
  dateField: {
    flex: 1,
  },
  filterLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#6e6e73',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
    marginBottom: 6,
  },
  paymentModeLabel: {
    marginTop: 14,
  },
  monthResetLink: {
    fontSize: 12,
    color: '#1a73e8',
    fontWeight: '600',
    marginTop: 8,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  chip: {
    borderWidth: 1,
    borderColor: '#d0d0d0',
    borderRadius: 20,
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  chipActive: {
    backgroundColor: '#e8f0fe',
    borderColor: '#1a73e8',
  },
  chipText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#6e6e73',
  },
  chipTextActive: {
    color: '#1a73e8',
  },
  summaryCard: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  summaryValueCr: {
    fontSize: 18,
    fontWeight: '700',
    color: '#2e7d32',
  },
  summaryValueDr: {
    fontSize: 18,
    fontWeight: '700',
    color: '#c0392b',
  },
  summaryLabel: {
    fontSize: 12,
    color: '#6e6e73',
    marginTop: 2,
  },
  exportButton: {
    backgroundColor: '#1a73e8',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 16,
  },
  exportButtonDisabled: {
    backgroundColor: '#a9c6f2',
  },
  exportButtonText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 15,
  },
  exportHint: {
    fontSize: 12,
    color: '#6e6e73',
    textAlign: 'center',
    marginTop: -8,
    marginBottom: 16,
  },
  empty: {
    fontSize: 14,
    color: '#777',
    textAlign: 'center',
    marginTop: 20,
  },
  tableScroll: {
    marginBottom: 12,
  },
  table: {
    backgroundColor: '#fff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e6e6e6',
    overflow: 'hidden',
  },
  tableRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  tableHeaderRow: {
    backgroundColor: '#f5f5f7',
  },
  tableFooterRow: {
    backgroundColor: '#f5f5f7',
    borderBottomWidth: 0,
  },
  tableRowAlt: {
    backgroundColor: '#fafafa',
  },
  tableCell: {
    paddingVertical: 10,
    paddingHorizontal: 10,
    fontSize: 13,
    color: '#1c1c1e',
    justifyContent: 'center',
  },
  tableHeaderText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#6e6e73',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  colDate: {
    width: 110,
  },
  colRef: {
    width: 140,
  },
  colMode: {
    width: 100,
  },
  colDirection: {
    width: 70,
  },
  colAmount: {
    width: 120,
  },
  colDescription: {
    width: 260,
  },
  cellBold: {
    fontWeight: '700',
  },
  cellCr: {
    color: '#2e7d32',
  },
  cellDr: {
    color: '#c0392b',
  },
  error: {
    color: '#c0392b',
    fontSize: 14,
    textAlign: 'center',
  },
  retryButton: {
    backgroundColor: '#1a73e8',
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 20,
  },
  retryButtonText: {
    color: '#fff',
    fontWeight: '600',
  },
});
