import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { apiGet, apiPost } from '../api/client';
import { useAuth } from '../context/AuthContext';

function formatMoney(amount) {
  return `\u20B9${Number(amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
}

// A dot (not "0") for a grid cell that doesn't apply to this row at all
// (e.g. Salary has no Income side) - keeps a genuine zero collected
// visually distinct from "this combination never happens", confirmed with
// the user while designing this report's grid.
function formatCell(amount, applies) {
  return applies ? formatMoney(amount) : '\u00B7';
}

function monthQueryParam(monthDate) {
  return `${monthDate.getFullYear()}-${String(monthDate.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(monthDate) {
  return monthDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function firstOfCurrentMonth() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Merges the Other row's own incomeBreakdown/expenseBreakdown (each an
// array of {description, count, online, cash, total} grouped by exact
// description match - see routes/society.js's computeMonthEndClosingFigures)
// into one flat list for rendering, each row tagged with which side(s) it
// actually has figures on. A description that happens to appear on both
// sides (recorded once as income, once as expense) renders as two separate
// rows rather than one merged row - simplest, and never ambiguous about
// which amount belongs to which side.
function combineOtherBreakdown(otherRow) {
  if (!otherRow) return [];
  const incomeRows = (otherRow.incomeBreakdown || []).map((item) => ({
    key: `income-${item.description}`,
    description: item.description || '(no description)',
    count: item.count,
    incomeOnline: item.online,
    incomeCash: item.cash,
    expenseOnline: 0,
    expenseCash: 0,
    hasIncome: true,
    hasExpense: false,
  }));
  const expenseRows = (otherRow.expenseBreakdown || []).map((item) => ({
    key: `expense-${item.description}`,
    description: item.description || '(no description)',
    count: item.count,
    incomeOnline: 0,
    incomeCash: 0,
    expenseOnline: item.online,
    expenseCash: item.cash,
    hasIncome: false,
    hasExpense: true,
  }));
  return [...incomeRows, ...expenseRows].sort((a, b) => a.description.localeCompare(b.description));
}

// Builds the literal A4 HTML the export/share button turns into a PDF -
// same hidden-iframe-on-web / expo-print-on-native split every other
// report export in this codebase uses (see PendencyReportScreen/
// TransactionReportScreen's own buildReportHtml). Confirmed with the user:
// only the Other row expands in this exported version - every other row
// (Maintenance/WaterCharge/UtilityBill/Salary) stays a single summary row,
// even though this is the one artifact that actually gets shared with
// every resident (over WhatsApp, not through the app itself), so it is
// deliberately plain black-on-white, no app theme colors.
function buildMonthEndClosingHtml({ societyName, monthText, data, generatedAtText }) {
  const rows = data.incomeExpense.rows;
  const otherRow = rows.find((r) => r.type === 'Other');
  const otherItems = combineOtherBreakdown(otherRow);

  const gridRow = (row) => `
    <tr>
      <td>${escapeHtml(row.label)}</td>
      <td class="num">${row.appliesTo.includes('income') ? escapeHtml(formatMoney(row.income.online)) : '\u2014'}</td>
      <td class="num">${row.appliesTo.includes('income') ? escapeHtml(formatMoney(row.income.cash)) : '\u2014'}</td>
      <td class="num">${row.appliesTo.includes('expense') ? escapeHtml(formatMoney(row.expense.online)) : '\u2014'}</td>
      <td class="num">${row.appliesTo.includes('expense') ? escapeHtml(formatMoney(row.expense.cash)) : '\u2014'}</td>
    </tr>`;

  const otherItemRow = (item) => `
    <tr class="detail">
      <td class="detail-desc">${escapeHtml(item.description)}${item.count > 1 ? ` <span class="count">(${item.count})</span>` : ''}</td>
      <td class="num">${item.hasIncome ? escapeHtml(formatMoney(item.incomeOnline)) : '\u2014'}</td>
      <td class="num">${item.hasIncome ? escapeHtml(formatMoney(item.incomeCash)) : '\u2014'}</td>
      <td class="num">${item.hasExpense ? escapeHtml(formatMoney(item.expenseOnline)) : '\u2014'}</td>
      <td class="num">${item.hasExpense ? escapeHtml(formatMoney(item.expenseCash)) : '\u2014'}</td>
    </tr>`;

  const gridRowsHtml = rows
    .map((row) => (row.type === 'Other' ? gridRow(row) + otherItems.map(otherItemRow).join('') : gridRow(row)))
    .join('');

  return `
    <html>
      <head>
        <meta charset="utf-8" />
        <style>
          @page { size: A4; margin: 18mm 14mm; }
          body { font-family: -apple-system, Helvetica, Arial, sans-serif; color: #000; }
          h1 { font-size: 20px; margin: 0 0 2px; }
          .subtitle { font-size: 13px; color: #333; margin-bottom: 18px; }
          .section-title { font-size: 13px; font-weight: 700; margin: 18px 0 6px; text-transform: uppercase; letter-spacing: 0.4px; }
          table { width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 4px; }
          th, td { border: 1px solid #000; padding: 6px 8px; text-align: left; }
          th { font-weight: 700; }
          td.num, th.num { text-align: right; }
          tr.total td { font-weight: 700; }
          tr.detail td { font-style: italic; color: #333; }
          td.detail-desc { padding-left: 20px; }
          .count { font-style: normal; color: #666; font-size: 10px; }
          .balance-pair { display: table; width: 100%; margin-bottom: 4px; }
          .balance-box { display: table-cell; width: 50%; border: 1px solid #000; padding: 10px; }
          .balance-box + .balance-box { border-left: none; }
          .balance-label { font-size: 11px; color: #333; text-transform: uppercase; letter-spacing: 0.3px; }
          .balance-value { font-size: 18px; font-weight: 700; margin-top: 2px; }
          .overall-pair { display: table; width: 100%; margin-bottom: 4px; }
          .overall-box { display: table-cell; width: 50%; border: 1px solid #000; padding: 10px; }
          .overall-box + .overall-box { border-left: none; }
          footer { margin-top: 24px; font-size: 10px; color: #555; border-top: 1px solid #000; padding-top: 8px; }
        </style>
      </head>
      <body>
        <h1>${escapeHtml(societyName)}</h1>
        <div class="subtitle">Month-End Closing Report \u2013 ${escapeHtml(monthText)}</div>

        <div class="section-title">Opening Balance</div>
        <div class="balance-pair">
          <div class="balance-box">
            <div class="balance-label">Bank Opening Balance</div>
            <div class="balance-value">${escapeHtml(formatMoney(data.openingBalance.bank))}</div>
          </div>
          <div class="balance-box">
            <div class="balance-label">Cash Opening Balance</div>
            <div class="balance-value">${escapeHtml(formatMoney(data.openingBalance.cash))}</div>
          </div>
        </div>

        <div class="section-title">Income / Expense</div>
        <table>
          <thead>
            <tr>
              <th rowspan="2">Type</th>
              <th colspan="2">Income</th>
              <th colspan="2">Expense</th>
            </tr>
            <tr>
              <th class="num">Online</th>
              <th class="num">Cash</th>
              <th class="num">Online</th>
              <th class="num">Cash</th>
            </tr>
          </thead>
          <tbody>
            ${gridRowsHtml}
            <tr class="total">
              <td>Totals</td>
              <td class="num">${escapeHtml(formatMoney(data.incomeExpense.totals.income.online))}</td>
              <td class="num">${escapeHtml(formatMoney(data.incomeExpense.totals.income.cash))}</td>
              <td class="num">${escapeHtml(formatMoney(data.incomeExpense.totals.expense.online))}</td>
              <td class="num">${escapeHtml(formatMoney(data.incomeExpense.totals.expense.cash))}</td>
            </tr>
          </tbody>
        </table>

        <div class="section-title">Overall Total</div>
        <div class="overall-pair">
          <div class="overall-box">
            <div class="balance-label">Total Income (Online + Cash)</div>
            <div class="balance-value">${escapeHtml(formatMoney(data.overallTotal.income))}</div>
          </div>
          <div class="overall-box">
            <div class="balance-label">Total Expense (Online + Cash)</div>
            <div class="balance-value">${escapeHtml(formatMoney(data.overallTotal.expense))}</div>
          </div>
        </div>

        <div class="section-title">Closing Balance</div>
        <div class="balance-pair">
          <div class="balance-box">
            <div class="balance-label">Bank Closing Balance</div>
            <div class="balance-value">${escapeHtml(formatMoney(data.closingBalance.bank))}</div>
          </div>
          <div class="balance-box">
            <div class="balance-label">Cash Closing Balance</div>
            <div class="balance-value">${escapeHtml(formatMoney(data.closingBalance.cash))}</div>
          </div>
        </div>

        <div class="section-title">Breakup of Maintenance Collection</div>
        <table>
          <thead>
            <tr>
              <th class="num">Online (UPI / NEFT / IMPS / Cheque)</th>
              <th class="num">Cash</th>
              <th class="num">Total</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td class="num">${escapeHtml(formatMoney(data.maintenanceBreakup.online))}</td>
              <td class="num">${escapeHtml(formatMoney(data.maintenanceBreakup.cash))}</td>
              <td class="num">${escapeHtml(formatMoney(data.maintenanceBreakup.total))}</td>
            </tr>
          </tbody>
        </table>

        <footer>Generated ${escapeHtml(generatedAtText)}. All amounts in INR. "Other" is broken down by exact transaction description for transparency.</footer>
      </body>
    </html>
  `;
}

// Admin/Committee "generate Month-End Closing report for a month" -
// Opening Balance (Bank + Cash, Admin-editable/overridable) -> Income/
// Expense grid (Online vs Cash, one row per transaction type, Other
// expandable by exact-match description) -> Overall Total -> Closing
// Balance -> Breakup of Maintenance Collection. Launched from within a
// society's own card on SocietyScreen, same as PendencyReportScreen/
// TransactionReportScreen. Backed by GET/POST
// /society/:id/month-end-closing (backend/src/routes/society.js).
//
// isAdmin controls whether the Opening Balance fields + Generate/Update
// button render at all - a Committee member gets a read-only view of
// whatever an Admin has already generated (or an explicit "not generated
// yet" empty state, never a live unsaved preview - see that route's own
// access-control comment).
export default function MonthEndClosingScreen({ society, isAdmin, onBack }) {
  const { accessToken } = useAuth();
  const [monthDate, setMonthDate] = useState(firstOfCurrentMonth);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [otherExpanded, setOtherExpanded] = useState(false);
  const [bankOpeningInput, setBankOpeningInput] = useState('0');
  const [cashOpeningInput, setCashOpeningInput] = useState('0');
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const result = await apiGet(
        `/society/${society.id}/month-end-closing?month=${monthQueryParam(monthDate)}`,
        accessToken
      );
      setData(result);
      if (result.openingBalance) {
        setBankOpeningInput(String(result.openingBalance.bank));
        setCashOpeningInput(String(result.openingBalance.cash));
      }
    } catch (err) {
      setError(err.message);
    }
  }, [accessToken, society.id, monthDate]);

  useEffect(() => {
    setLoading(true);
    setOtherExpanded(false);
    setGenerateError(null);
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

  const isCurrentMonth = (() => {
    const now = new Date();
    return monthDate.getFullYear() === now.getFullYear() && monthDate.getMonth() === now.getMonth();
  })();

  const handleGenerate = async () => {
    const bank = Number(bankOpeningInput);
    const cash = Number(cashOpeningInput);
    if (Number.isNaN(bank) || Number.isNaN(cash)) {
      setGenerateError('Bank and Cash opening balances must both be numbers.');
      return;
    }
    setGenerateError(null);
    setGenerating(true);
    try {
      const result = await apiPost(`/society/${society.id}/month-end-closing`, accessToken, {
        month: monthQueryParam(monthDate),
        bank_opening_balance: bank,
        cash_opening_balance: cash,
      });
      setData(result);
    } catch (err) {
      setGenerateError(err.message);
    } finally {
      setGenerating(false);
    }
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const html = buildMonthEndClosingHtml({
        societyName: society.name,
        monthText: monthLabel(monthDate),
        data,
        generatedAtText: data.generatedAt
          ? new Date(data.generatedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
          : new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
      });
      if (Platform.OS === 'web') {
        // Same hidden-iframe print technique as PendencyReportScreen's own
        // handleExport - see that screen's comment for why window.open/
        // document.write/blob-URL alternatives were all tried and dropped.
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
          await Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle: 'Share Month-End Closing report' });
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

  const openingSourceHint = (source) => {
    if (source === 'saved') return 'Saved for this month.';
    if (source === 'manual_override') return 'Manually entered.';
    if (source === 'previous_month_closing') return "Auto-filled from last month's closing balance.";
    return 'Not yet set - enter manually.';
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
    >
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Month-End Closing</Text>
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
            <TouchableOpacity onPress={() => setMonthDate(firstOfCurrentMonth())}>
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
      ) : !data.generated && !isAdmin ? (
        <View style={styles.centered}>
          <Text style={styles.empty}>
            {monthLabel(monthDate)} has not been generated yet. Check back once an Admin has generated it.
          </Text>
        </View>
      ) : (
        <>
          {isAdmin && data.guard?.blocked ? (
            <View style={styles.guardBanner}>
              <Text style={styles.guardBannerText}>
                {data.guard.blockedCount} transaction{data.guard.blockedCount === 1 ? '' : 's'} dated on or before{' '}
                {monthLabel(monthDate)} {data.guard.blockedCount === 1 ? 'is' : 'are'} still awaiting review.
                Generation is blocked until {data.guard.blockedCount === 1 ? 'it is' : 'they are'} verified or
                rejected.
              </Text>
            </View>
          ) : null}

          {!data.generated ? (
            <View style={styles.previewBanner}>
              <Text style={styles.previewBannerText}>
                Preview only - {monthLabel(monthDate)} has not been generated yet.
              </Text>
            </View>
          ) : null}

          <Text style={styles.sectionTitle}>Opening Balance</Text>
          <View style={styles.balanceRow}>
            <View style={styles.balanceBox}>
              <Text style={styles.balanceLabel}>Bank</Text>
              {isAdmin ? (
                <TextInput
                  style={styles.balanceInput}
                  keyboardType="numeric"
                  value={bankOpeningInput}
                  onChangeText={setBankOpeningInput}
                  editable={!generating}
                />
              ) : (
                <Text style={styles.balanceValue}>{formatMoney(data.openingBalance.bank)}</Text>
              )}
              {isAdmin ? <Text style={styles.balanceHint}>{openingSourceHint(data.openingBalance.source)}</Text> : null}
            </View>
            <View style={styles.balanceBox}>
              <Text style={styles.balanceLabel}>Cash</Text>
              {isAdmin ? (
                <TextInput
                  style={styles.balanceInput}
                  keyboardType="numeric"
                  value={cashOpeningInput}
                  onChangeText={setCashOpeningInput}
                  editable={!generating}
                />
              ) : (
                <Text style={styles.balanceValue}>{formatMoney(data.openingBalance.cash)}</Text>
              )}
            </View>
          </View>

          {isAdmin ? (
            <>
              <TouchableOpacity
                style={[
                  styles.generateButton,
                  (generating || data.guard?.blocked) && styles.generateButtonDisabled,
                ]}
                onPress={handleGenerate}
                disabled={generating || data.guard?.blocked}
              >
                {generating ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.generateButtonText}>
                    {data.generated ? 'Re-Generate This Month' : 'Generate This Month'}
                  </Text>
                )}
              </TouchableOpacity>
              {generateError ? <Text style={styles.error}>{generateError}</Text> : null}
            </>
          ) : null}

          <Text style={styles.sectionTitle}>Income / Expense</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator style={styles.tableScroll}>
            <View style={styles.table}>
              <View style={[styles.tableRow, styles.groupHeaderRow]}>
                <View style={styles.colType} />
                <Text style={[styles.groupHeaderText, styles.colGroup]}>Income</Text>
                <Text style={[styles.groupHeaderText, styles.colGroup]}>Expense</Text>
              </View>
              <View style={[styles.tableRow, styles.tableHeaderRow]}>
                <Text style={[styles.tableCell, styles.tableHeaderText, styles.colType]}>Type</Text>
                <Text style={[styles.tableCell, styles.tableHeaderText, styles.colAmount]}>Online</Text>
                <Text style={[styles.tableCell, styles.tableHeaderText, styles.colAmount]}>Cash</Text>
                <Text style={[styles.tableCell, styles.tableHeaderText, styles.colAmount]}>Online</Text>
                <Text style={[styles.tableCell, styles.tableHeaderText, styles.colAmount]}>Cash</Text>
              </View>

              {data.incomeExpense.rows.map((row) => {
                const isOther = row.type === 'Other';
                const otherItems = isOther ? combineOtherBreakdown(row) : [];
                return (
                  <View key={row.type}>
                    <TouchableOpacity
                      style={[styles.tableRow, styles.dataRow]}
                      onPress={isOther ? () => setOtherExpanded((prev) => !prev) : undefined}
                      disabled={!isOther}
                    >
                      <View style={[styles.tableCell, styles.colType, styles.rowLabelCell]}>
                        <Text style={styles.rowLabelText}>{row.label}</Text>
                        {isOther ? (
                          <Text style={styles.expandChevron}>{otherExpanded ? '\u25B4' : '\u25BE'}</Text>
                        ) : null}
                      </View>
                      <Text style={[styles.tableCell, styles.colAmount]}>
                        {formatCell(row.income.online, row.appliesTo.includes('income'))}
                      </Text>
                      <Text style={[styles.tableCell, styles.colAmount]}>
                        {formatCell(row.income.cash, row.appliesTo.includes('income'))}
                      </Text>
                      <Text style={[styles.tableCell, styles.colAmount]}>
                        {formatCell(row.expense.online, row.appliesTo.includes('expense'))}
                      </Text>
                      <Text style={[styles.tableCell, styles.colAmount]}>
                        {formatCell(row.expense.cash, row.appliesTo.includes('expense'))}
                      </Text>
                    </TouchableOpacity>

                    {isOther && otherExpanded
                      ? otherItems.map((item) => (
                          <View key={item.key} style={[styles.tableRow, styles.detailRow]}>
                            <View style={[styles.tableCell, styles.colType]}>
                              <Text style={styles.detailDescText} numberOfLines={2}>
                                {item.description}
                                {item.count > 1 ? <Text style={styles.detailCount}> ({item.count})</Text> : null}
                              </Text>
                            </View>
                            <Text style={[styles.tableCell, styles.colAmount, styles.detailAmountText]}>
                              {item.hasIncome ? formatMoney(item.incomeOnline) : '\u2014'}
                            </Text>
                            <Text style={[styles.tableCell, styles.colAmount, styles.detailAmountText]}>
                              {item.hasIncome ? formatMoney(item.incomeCash) : '\u2014'}
                            </Text>
                            <Text style={[styles.tableCell, styles.colAmount, styles.detailAmountText]}>
                              {item.hasExpense ? formatMoney(item.expenseOnline) : '\u2014'}
                            </Text>
                            <Text style={[styles.tableCell, styles.colAmount, styles.detailAmountText]}>
                              {item.hasExpense ? formatMoney(item.expenseCash) : '\u2014'}
                            </Text>
                          </View>
                        ))
                      : null}
                    {isOther && otherExpanded && otherItems.length === 0 ? (
                      <View style={[styles.tableRow, styles.detailRow]}>
                        <Text style={[styles.tableCell, styles.colType, styles.detailDescText]}>
                          No "Other" transactions this month.
                        </Text>
                        <View style={[styles.tableCell, styles.colAmount]} />
                        <View style={[styles.tableCell, styles.colAmount]} />
                        <View style={[styles.tableCell, styles.colAmount]} />
                        <View style={[styles.tableCell, styles.colAmount]} />
                      </View>
                    ) : null}
                  </View>
                );
              })}

              <View style={[styles.tableRow, styles.tableFooterRow]}>
                <Text style={[styles.tableCell, styles.colType, styles.cellBold]}>Totals</Text>
                <Text style={[styles.tableCell, styles.colAmount, styles.cellBold]}>
                  {formatMoney(data.incomeExpense.totals.income.online)}
                </Text>
                <Text style={[styles.tableCell, styles.colAmount, styles.cellBold]}>
                  {formatMoney(data.incomeExpense.totals.income.cash)}
                </Text>
                <Text style={[styles.tableCell, styles.colAmount, styles.cellBold]}>
                  {formatMoney(data.incomeExpense.totals.expense.online)}
                </Text>
                <Text style={[styles.tableCell, styles.colAmount, styles.cellBold]}>
                  {formatMoney(data.incomeExpense.totals.expense.cash)}
                </Text>
              </View>
            </View>
          </ScrollView>

          <Text style={styles.sectionTitle}>Overall Total</Text>
          <View style={styles.balanceRow}>
            <View style={[styles.balanceBox, styles.incomeBox]}>
              <Text style={styles.balanceLabel}>Total Income</Text>
              <Text style={[styles.balanceValue, styles.incomeText]}>{formatMoney(data.overallTotal.income)}</Text>
            </View>
            <View style={[styles.balanceBox, styles.expenseBox]}>
              <Text style={styles.balanceLabel}>Total Expense</Text>
              <Text style={[styles.balanceValue, styles.expenseText]}>{formatMoney(data.overallTotal.expense)}</Text>
            </View>
          </View>

          <Text style={styles.sectionTitle}>Closing Balance</Text>
          <View style={styles.balanceRow}>
            <View style={styles.balanceBox}>
              <Text style={styles.balanceLabel}>Bank</Text>
              <Text style={styles.balanceValue}>{formatMoney(data.closingBalance.bank)}</Text>
            </View>
            <View style={styles.balanceBox}>
              <Text style={styles.balanceLabel}>Cash</Text>
              <Text style={styles.balanceValue}>{formatMoney(data.closingBalance.cash)}</Text>
            </View>
          </View>

          <Text style={styles.sectionTitle}>Breakup of Maintenance Collection</Text>
          <View style={styles.balanceRow}>
            <View style={styles.balanceBox}>
              <Text style={styles.balanceLabel}>Online (UPI / NEFT / IMPS / Cheque)</Text>
              <Text style={styles.balanceValue}>{formatMoney(data.maintenanceBreakup.online)}</Text>
            </View>
            <View style={styles.balanceBox}>
              <Text style={styles.balanceLabel}>Cash</Text>
              <Text style={styles.balanceValue}>{formatMoney(data.maintenanceBreakup.cash)}</Text>
            </View>
          </View>

          <TouchableOpacity
            style={[styles.exportButton, (!data.generated || exporting) && styles.exportButtonDisabled]}
            onPress={handleExport}
            disabled={!data.generated || exporting}
          >
            {exporting ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.exportButtonText}>Export as PDF / Share</Text>
            )}
          </TouchableOpacity>
          {!data.generated ? (
            <Text style={styles.exportHint}>Generate this month's closing before exporting/sharing it.</Text>
          ) : Platform.OS === 'web' ? (
            <Text style={styles.exportHint}>
              A print preview will open in a new tab - choose "Save as PDF" as the destination there to download it.
            </Text>
          ) : null}
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
    padding: 20,
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
  guardBanner: {
    backgroundColor: '#fdecea',
    borderRadius: 10,
    padding: 14,
    marginBottom: 16,
  },
  guardBannerText: {
    fontSize: 13,
    color: '#c0392b',
    fontWeight: '600',
  },
  previewBanner: {
    backgroundColor: '#fff8e1',
    borderRadius: 10,
    padding: 12,
    marginBottom: 16,
  },
  previewBannerText: {
    fontSize: 13,
    color: '#8a6d00',
    fontWeight: '600',
    textAlign: 'center',
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#6e6e73',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginTop: 8,
    marginBottom: 8,
  },
  balanceRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 16,
  },
  balanceBox: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 14,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  incomeBox: {
    backgroundColor: '#e6f4ea',
  },
  expenseBox: {
    backgroundColor: '#fdecea',
  },
  balanceLabel: {
    fontSize: 12,
    color: '#6e6e73',
    fontWeight: '600',
    marginBottom: 6,
  },
  balanceValue: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1c1c1e',
  },
  incomeText: {
    color: '#2e7d32',
  },
  expenseText: {
    color: '#c0392b',
  },
  balanceInput: {
    borderWidth: 1,
    borderColor: '#d0d0d0',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 16,
    fontWeight: '700',
    color: '#1c1c1e',
  },
  balanceHint: {
    fontSize: 11,
    color: '#6e6e73',
    marginTop: 6,
  },
  generateButton: {
    backgroundColor: '#1a73e8',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 16,
  },
  generateButtonDisabled: {
    backgroundColor: '#a9c6f2',
  },
  generateButtonText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 15,
  },
  tableScroll: {
    marginBottom: 16,
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
  groupHeaderRow: {
    backgroundColor: '#eef3fc',
    borderBottomWidth: 0,
  },
  groupHeaderText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#1a73e8',
    textAlign: 'center',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    paddingVertical: 6,
  },
  tableHeaderRow: {
    backgroundColor: '#f5f5f7',
  },
  tableFooterRow: {
    backgroundColor: '#f5f5f7',
    borderBottomWidth: 0,
  },
  dataRow: {
    backgroundColor: '#fff',
  },
  detailRow: {
    backgroundColor: '#fafbfd',
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
    textAlign: 'center',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  colType: {
    width: 140,
  },
  colGroup: {
    width: 180,
  },
  colAmount: {
    width: 90,
    textAlign: 'right',
  },
  rowLabelCell: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  rowLabelText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#1c1c1e',
  },
  expandChevron: {
    fontSize: 12,
    color: '#1a73e8',
    fontWeight: '700',
  },
  detailDescText: {
    fontSize: 12,
    color: '#444',
    fontStyle: 'italic',
  },
  detailCount: {
    fontSize: 11,
    color: '#888',
    fontStyle: 'normal',
  },
  detailAmountText: {
    fontSize: 12,
    color: '#444',
    fontStyle: 'italic',
    textAlign: 'right',
  },
  cellBold: {
    fontWeight: '700',
    textAlign: 'right',
  },
  exportButton: {
    backgroundColor: '#1a73e8',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 8,
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
    marginBottom: 16,
  },
  empty: {
    fontSize: 14,
    color: '#777',
    textAlign: 'center',
  },
  error: {
    color: '#c0392b',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 12,
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
