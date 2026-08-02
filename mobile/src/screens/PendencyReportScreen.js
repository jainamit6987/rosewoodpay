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

// period_month/lastPaidBillingPeriod are both plain 'YYYY-MM-DD' date-only
// strings from billing_periods - parsed as UTC to sidestep the classic
// "midnight local time rolls back a day" bug a bare `new Date('2026-07-01')`
// display would otherwise hit in timezones behind UTC.
function formatMonth(dateOnly) {
  if (!dateOnly) return '\u2014';
  const [year, month] = dateOnly.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString(undefined, {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function monthQueryParam(monthDate) {
  return `${monthDate.getFullYear()}-${String(monthDate.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(monthDate) {
  return monthDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function openPeriodNames(house) {
  const names = (house.openPeriods || []).map((p) => formatMonth(p.period_month));
  return names.length > 0 ? names.join(', ') : '\u2014';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Builds the literal HTML table the export/share button turns into a PDF -
// deliberately a real table here (unlike the card-per-house layout on
// screen, too cramped for a phone width) since the whole point of this
// export is a document someone reads outside the app, in the same column
// order the user asked for: House No, Due Amount, Open Billing Periods,
// last payment date, last paid billing period.
function buildReportHtml({ societyName, monthText, houses, grandTotal }) {
  const rows = houses
    .map(
      (house) => `
        <tr>
          <td>${escapeHtml(house.house_number)}</td>
          <td class="num">${escapeHtml(formatMoney(house.totalOutstanding))}</td>
          <td>${escapeHtml(openPeriodNames(house))}</td>
          <td>${escapeHtml(formatDate(house.lastPayment?.date))}</td>
          <td>${escapeHtml(formatMonth(house.lastPaidBillingPeriod))}</td>
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
        <h1>${escapeHtml(societyName)} \u2013 Pendency Report</h1>
        <div class="subtitle">As of ${escapeHtml(monthText)} \u2022 ${houses.length} house${houses.length === 1 ? '' : 's'} with dues</div>
        <table>
          <thead>
            <tr>
              <th>House No</th>
              <th class="num">Due Amount</th>
              <th>Open Billing Periods</th>
              <th>Last Payment Date</th>
              <th>Last Paid Period</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
          <tfoot>
            <tr>
              <td>Total</td>
              <td class="num">${escapeHtml(formatMoney(grandTotal))}</td>
              <td colspan="3"></td>
            </tr>
          </tfoot>
        </table>
      </body>
    </html>
  `;
}

// Admin/Committee "generate pendency report for a month" (workflow S.No
// 25) - who still owes money, as of a chosen month, backed by the
// already-built GET /society/:id/pendency-report. Launched from within a
// society's own card on SocietyScreen, since this is a whole-society
// report, not scoped to one house the way HouseTransactionsScreen/
// BillingHistoryScreen are.
export default function PendencyReportScreen({ society, onBack }) {
  const { accessToken } = useAuth();
  const [monthDate, setMonthDate] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [houses, setHouses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    try {
      setError(null);
      const data = await apiGet(
        `/society/${society.id}/pendency-report?month=${monthQueryParam(monthDate)}`,
        accessToken
      );
      setHouses(data.houses || []);
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

  const grandTotal = useMemo(
    () => houses.reduce((sum, house) => sum + Number(house.totalOutstanding), 0),
    [houses]
  );

  const handleExport = async () => {
    setExporting(true);
    try {
      const html = buildReportHtml({
        societyName: society.name,
        monthText: monthLabel(monthDate),
        houses,
        grandTotal,
      });
      if (Platform.OS === 'web') {
        // expo-print's own web implementation of printAsync ignores the
        // `html` option entirely and just calls the browser's raw
        // window.print() on whatever page is currently open - it would
        // print this app screen itself, not the report, so that API is
        // not used here at all on web.
        //
        // Two earlier attempts at opening a separate window/tab both
        // produced a blank result in practice:
        //   1. window.open('', '_blank') + document.write(html) - modern
        //      Chrome frequently "intervenes" on document.write into a
        //      manually-opened blank window and silently drops it.
        //   2. window.open(blobUrl, '_blank') - navigating a brand new
        //      tab straight to a blob: URL is also unreliable, and users
        //      can't retype/resubmit a blob: URL from the address bar
        //      (browsers treat that as a search query, not a navigation),
        //      which is a dead end for troubleshooting a blank tab too.
        //
        // The reliable, popup-free technique is a hidden <iframe> on the
        // current page: set its srcdoc to the report HTML, wait for it to
        // load, then call print() on just that iframe's window. This is
        // the standard "print this content, not the whole app" trick used
        // by most web print libraries, and it sidesteps popup blockers,
        // window.open timing, and blob URL navigation entirely. There is
        // still no native share sheet on web, so the browser's own print
        // dialog (offering "Save as PDF"/"Microsoft Print to PDF" as a
        // destination) remains the closest equivalent action available
        // there; the user still has to pick that destination and click
        // Save themselves - no web page can silently write a file to disk
        // without that explicit step.
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
          // Choosing "Save as PDF" opens the OS file-save dialog, which
          // can stay open for as long as the user takes to pick a folder
          // - removing the iframe too early (a fixed short delay was
          // tried before) deletes the print job's source content before
          // Windows/Chrome finishes writing the file, so the save
          // silently produces nothing. `afterprint` fires once the
          // dialog is actually dismissed (save OR cancel), so it's the
          // correct signal to clean up on; the timeout is just a safety
          // net in case a browser never fires it.
          iframe.contentWindow.addEventListener('afterprint', cleanup);
          setTimeout(cleanup, 5 * 60 * 1000);
        };
        iframe.srcdoc = html;
      } else {
        const { uri } = await Print.printToFileAsync({ html });
        const canShare = await Sharing.isAvailableAsync();
        if (canShare) {
          await Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle: 'Share pendency report' });
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
          <Text style={styles.title}>Pendency Report</Text>
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
              <Text style={styles.summaryValue}>
                {houses.length} house{houses.length === 1 ? '' : 's'}
              </Text>
              <Text style={styles.summaryLabel}>with outstanding dues</Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={styles.summaryValue}>{formatMoney(grandTotal)}</Text>
              <Text style={styles.summaryLabel}>total outstanding</Text>
            </View>
          </View>

          <TouchableOpacity
            style={[styles.exportButton, (exporting || houses.length === 0) && styles.exportButtonDisabled]}
            onPress={handleExport}
            disabled={exporting || houses.length === 0}
          >
            {exporting ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.exportButtonText}>Export as PDF / Share</Text>
            )}
          </TouchableOpacity>
          {Platform.OS === 'web' && houses.length > 0 ? (
            <Text style={styles.exportHint}>
              A print preview will open in a new tab - choose "Save as PDF" as the destination there to download it.
            </Text>
          ) : null}

          {houses.length === 0 ? (
            <Text style={styles.empty}>No houses have outstanding dues for {monthLabel(monthDate)}.</Text>
          ) : (
            // A real table, same column order as the PDF export (House No,
            // Due Amount, Open Billing Periods, Last Payment Date, Last
            // Paid Period) - wrapped in its own horizontal ScrollView since
            // 5 columns of real data does not fit a phone-width screen;
            // wider viewports (tablet/web) show the whole thing with
            // nothing to scroll.
            <ScrollView horizontal showsHorizontalScrollIndicator style={styles.tableScroll}>
              <View style={styles.table}>
                <View style={[styles.tableRow, styles.tableHeaderRow]}>
                  <Text style={[styles.tableCell, styles.tableHeaderText, styles.colHouse]}>House No</Text>
                  <Text style={[styles.tableCell, styles.tableHeaderText, styles.colAmount]}>Due Amount</Text>
                  <Text style={[styles.tableCell, styles.tableHeaderText, styles.colPeriods]}>
                    Open Billing Periods
                  </Text>
                  <Text style={[styles.tableCell, styles.tableHeaderText, styles.colDate]}>Last Payment Date</Text>
                  <Text style={[styles.tableCell, styles.tableHeaderText, styles.colDate]}>Last Paid Period</Text>
                </View>

                {houses.map((house, index) => (
                  <View
                    key={house.house_id}
                    style={[styles.tableRow, index % 2 === 1 ? styles.tableRowAlt : null]}
                  >
                    <Text style={[styles.tableCell, styles.colHouse, styles.cellBold]}>{house.house_number}</Text>
                    <View style={[styles.tableCell, styles.colAmount]}>
                      <Text style={styles.cellDueAmount}>{formatMoney(house.totalOutstanding)}</Text>
                      {house.overdueMonths > 0 ? (
                        <Text style={styles.cellOverdueTag}>
                          {house.overdueMonths} mo{house.overdueMonths === 1 ? '' : 's'} overdue
                        </Text>
                      ) : null}
                    </View>
                    <Text style={[styles.tableCell, styles.colPeriods]}>{openPeriodNames(house)}</Text>
                    <Text style={[styles.tableCell, styles.colDate]}>{formatDate(house.lastPayment?.date)}</Text>
                    <Text style={[styles.tableCell, styles.colDate]}>
                      {formatMonth(house.lastPaidBillingPeriod)}
                    </Text>
                  </View>
                ))}

                <View style={[styles.tableRow, styles.tableFooterRow]}>
                  <Text style={[styles.tableCell, styles.colHouse, styles.cellBold]}>Total</Text>
                  <Text style={[styles.tableCell, styles.colAmount, styles.cellBold]}>{formatMoney(grandTotal)}</Text>
                  <View style={[styles.tableCell, styles.colPeriods]} />
                  <View style={[styles.tableCell, styles.colDate]} />
                  <View style={[styles.tableCell, styles.colDate]} />
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
  summaryValue: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1c1c1e',
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
  colHouse: {
    width: 90,
  },
  colAmount: {
    width: 120,
  },
  colPeriods: {
    width: 220,
  },
  colDate: {
    width: 120,
  },
  cellBold: {
    fontWeight: '700',
  },
  cellDueAmount: {
    fontSize: 13,
    fontWeight: '700',
    color: '#c0392b',
  },
  cellOverdueTag: {
    fontSize: 10,
    fontWeight: '700',
    color: '#c0392b',
    marginTop: 2,
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
