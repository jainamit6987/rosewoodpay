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
import { apiGet } from '../api/client';
import { useAuth } from '../context/AuthContext';

function formatMoney(amount) {
  return `\u20B9${Number(amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
}

function formatDate(value) {
  if (!value) return '\u2014';
  return new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

// Kept in sync with routes/society.js's own PAYMENT_MODES labels (see
// RecordExpenseScreen's identical lookup) - just the display label here,
// since this screen only ever reads payment_mode back, never writes it.
const PAYMENT_MODE_LABELS = {
  UPI: 'UPI',
  Cash: 'Cash',
  NEFT_IMPS: 'NEFT/IMPS',
  Cheque: 'Cheque',
};

function formatPaymentMode(mode) {
  return PAYMENT_MODE_LABELS[mode] || mode;
}

function monthQueryParam(monthDate) {
  return `${monthDate.getFullYear()}-${String(monthDate.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(monthDate) {
  return monthDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
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
function buildReportHtml({ societyName, monthText, rows, totalCr, totalDr }) {
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
        <div class="subtitle">${escapeHtml(monthText)} \u2022 ${rows.length} transaction${rows.length === 1 ? '' : 's'}</div>
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
// whole-society ledger for a chosen calendar month, backed by
// GET /society/:id/transaction-report. Every Verified transaction either
// direction: Cr (a resident's Maintenance or WaterCharge payment, money in)
// or Dr (a society expense - Salary/UtilityBill/Other, money out). Launched from
// within a society's own card on SocietyScreen, same shape as
// PendencyReportScreen (both are whole-society reports, not scoped to one
// house).
export default function TransactionReportScreen({ society, onBack }) {
  const { accessToken } = useAuth();
  const [monthDate, setMonthDate] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    try {
      setError(null);
      const data = await apiGet(
        `/society/${society.id}/transaction-report?month=${monthQueryParam(monthDate)}`,
        accessToken
      );
      setTransactions(data.transactions || []);
    } catch (err) {
      setError(err.message);
    }
  }, [accessToken, society.id, monthDate]);

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const shiftMonth = (delta) => {
    setMonthDate((prev) => new Date(prev.getFullYear(), prev.getMonth() + delta, 1));
  };

  const isCurrentMonth = useMemo(() => {
    const now = new Date();
    return monthDate.getFullYear() === now.getFullYear() && monthDate.getMonth() === now.getMonth();
  }, [monthDate]);

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
        monthText: monthLabel(monthDate),
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

      <View style={styles.monthRow}>
        <TouchableOpacity style={styles.monthArrow} onPress={() => shiftMonth(-1)}>
          <Text style={styles.monthArrowText}>{'\u25C0'}</Text>
        </TouchableOpacity>
        <View style={styles.monthLabelBox}>
          <Text style={styles.monthLabelText}>{monthLabel(monthDate)}</Text>
          {!isCurrentMonth ? (
            <TouchableOpacity onPress={() => setMonthDate(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}>
              <Text style={styles.monthResetLink}>Jump to current month</Text>
            </TouchableOpacity>
          ) : null}
        </View>
        <TouchableOpacity style={styles.monthArrow} onPress={() => shiftMonth(1)}>
          <Text style={styles.monthArrowText}>{'\u25B6'}</Text>
        </TouchableOpacity>
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
            <Text style={styles.empty}>No transactions recorded for {monthLabel(monthDate)}.</Text>
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
  monthRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
    borderRadius: 10,
    paddingVertical: 12,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  monthArrow: {
    paddingHorizontal: 20,
  },
  monthArrowText: {
    fontSize: 16,
    color: '#1a73e8',
    fontWeight: '700',
  },
  monthLabelBox: {
    alignItems: 'center',
    minWidth: 160,
  },
  monthLabelText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1c1c1e',
  },
  monthResetLink: {
    fontSize: 12,
    color: '#1a73e8',
    fontWeight: '600',
    marginTop: 4,
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
