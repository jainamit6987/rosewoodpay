import { useCallback, useEffect, useState } from 'react';
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
import { amountInWords } from '../utils/numberToWords';

// Static per product decision (see Society_App_Progress_Log.md) - the
// `societies` table has no address column, and the user explicitly chose a
// hardcoded value here over adding one just for this one receipt line.
const SOCIETY_ADDRESS = 'Near Sundar Nagar, Bhopal (M.P.)';

// Strictly monochrome black-on-white, matching the printed-voucher palette
// approved in canvases/maintenance-receipt-mockup.canvas.tsx - the only two
// exceptions are the Status *value* and the Rejected watermark, both of
// which keep their semantic color so the outcome is scannable at a glance.
const INK = '#111111';
const RULE_LIGHT = '#c9c9c9';
const STATUS_COLOR = { Approved: '#1a7a3b', 'Pending Approval': '#8a6d00', Rejected: '#b3261e' };

const PAYMENT_MODES = [
  { value: 'Cash', label: 'Cash' },
  { value: 'UPI', label: 'UPI' },
  { value: 'Cheque', label: 'Cheque' },
  { value: 'NEFT_IMPS', label: 'NEFT/IMPS' },
];

function formatMoney(amount) {
  return `\u20B9${Number(amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
}

function monthYearLabel(periodMonth) {
  const date = new Date(periodMonth);
  return {
    month: date.toLocaleDateString(undefined, { month: 'long' }),
    year: String(date.getFullYear()),
  };
}

function formatDate(dateValue) {
  if (!dateValue) return '\u2014';
  return new Date(dateValue).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Literal HTML twin of <ReceiptCard/> below, for Export/Share - same split
// as every other report in this codebase (see MonthEndClosingScreen's own
// buildMonthEndClosingHtml): the in-app view and the exported PDF are two
// separate renderers of the same data, not one shared component, since RN
// views cannot themselves become an HTML/PDF document.
function buildReceiptHtml({ receipt, houseNumber }) {
  const { month, year } = monthYearLabel(receipt.periodMonth);
  const amountWords = amountInWords(receipt.amount);
  const statusColor = STATUS_COLOR[receipt.status] || INK;

  const checkboxesHtml = PAYMENT_MODES.map(
    (mode) => `
      <span class="cb">
        <span class="cb-box">${mode.value === receipt.paymentMode ? '\u2713' : ''}</span>
        <span>${escapeHtml(mode.label)}</span>
      </span>`
  ).join('');

  return `
    <html>
      <head>
        <meta charset="utf-8" />
        <style>
          @page { size: A4; margin: 20mm 16mm; }
          body { font-family: 'Segoe UI', Arial, Helvetica, sans-serif; color: ${INK}; display: flex; justify-content: center; }
          .receipt { width: 520px; border: 2px solid #000; border-radius: 18px; overflow: hidden; position: relative; }
          .center { text-align: center; }
          .masthead { padding: 5px 12px; }
          .society-name { font-weight: 700; font-size: 15px; }
          .society-address { font-size: 12px; }
          .receipt-title { font-weight: 700; font-size: 13px; letter-spacing: 2px; }
          .grid-top { border-top: 1px solid #000; }
          .row { display: flex; border-bottom: 1px solid ${RULE_LIGHT}; padding: 6px 12px; font-size: 13px; }
          .row.full { display: block; }
          .cell { flex: 1; }
          .cell + .cell { border-left: 1px solid ${RULE_LIGHT}; padding-left: 12px; margin-left: -12px; }
          .cell.wide { flex: 1.4; }
          b { font-weight: 700; }
          .cb { display: inline-flex; align-items: center; gap: 5px; margin-right: 16px; }
          .cb-box { display: inline-block; width: 13px; height: 13px; border: 1.4px solid #000; text-align: center; line-height: 12px; font-size: 10px; font-weight: 700; }
          .footer { display: flex; justify-content: space-between; align-items: flex-end; padding: 14px 12px 12px; border-top: 1px solid #000; font-size: 11px; }
          .status-value { color: ${statusColor}; font-weight: 700; }
          .footer-right { text-align: right; }
          .received-by-name { font-size: 12px; font-weight: 700; margin-top: 14px; }
          .role-caption { font-size: 10px; }
          .watermark { position: absolute; top: 90px; left: 30px; right: 30px; text-align: center; font-size: 42px; font-weight: 700; color: #b3261e; opacity: 0.22; transform: rotate(-16deg); letter-spacing: 4px; }
        </style>
      </head>
      <body>
        <div class="receipt">
          ${receipt.status === 'Rejected' ? '<div class="watermark">NOT VALID</div>' : ''}
          <div class="masthead center society-name">${escapeHtml(receipt.societyName)}</div>
          <div class="masthead center society-address">${escapeHtml(SOCIETY_ADDRESS)}</div>
          <div class="masthead center receipt-title">RECEIPT</div>

          <div class="grid-top">
            <div class="row">
              <div class="cell">Mob No <b>${escapeHtml(receipt.residentMobile || '\u2014')}</b></div>
              <div class="cell">Date <b>${escapeHtml(formatDate(receipt.date))}</b></div>
            </div>
            <div class="row">
              <div class="cell wide">Received From Mr/Mrs/Miss <b>${escapeHtml(receipt.residentName)}</b></div>
              <div class="cell">H No / Flat No <b>${escapeHtml(houseNumber)}</b></div>
            </div>
            <div class="row full">On the account of Monthly Society Maintenance for the month of <b>${escapeHtml(month)} ${escapeHtml(year)}</b></div>
            <div class="row full">Sum of INR <b>${escapeHtml(formatMoney(receipt.amount))}</b> <i>(${escapeHtml(amountWords)})</i></div>
            <div class="row full">By ${checkboxesHtml}</div>
            <div class="row"><div class="cell">Ref No <b>${escapeHtml(receipt.refNo || '\u2014')}</b></div></div>
            ${
              receipt.status === 'Rejected'
                ? `<div class="row full" style="border-bottom:none;"><b>Reason for rejection:</b> ${escapeHtml(receipt.rejectionReason || '\u2014')}</div>`
                : ''
            }
          </div>

          <div class="footer">
            <div>Status: <span class="status-value">${escapeHtml(receipt.status)}</span></div>
            <div class="footer-right">
              <div>Received By</div>
              <div class="received-by-name">${escapeHtml(receipt.receivedBy || '\u2014')}</div>
              <div class="role-caption">Treasurer / Sub Treasurer</div>
            </div>
          </div>
        </div>
      </body>
    </html>
  `;
}

// One row of the printed grid - RN counterpart of the mockup's GridRow,
// full-width, single ruled line below (never a table cell split).
function GridRow({ children, last }) {
  return <View style={[styles.gridRow, last && styles.noBorder]}><Text style={styles.gridRowText}>{children}</Text></View>;
}

// Two-up split row (Mob No/Date, Received From/H No) - a vertical rule
// between the two halves, same as the mockup's raw flex rows.
function SplitRow({ leftFlex = 1, left, right }) {
  return (
    <View style={styles.splitRow}>
      <View style={[styles.splitCell, { flex: leftFlex, borderRightWidth: 1, borderRightColor: RULE_LIGHT }]}>
        <Text style={styles.gridRowText}>{left}</Text>
      </View>
      <View style={[styles.splitCell, { flex: 1 }]}>
        <Text style={styles.gridRowText}>{right}</Text>
      </View>
    </View>
  );
}

function ReceiptCard({ receipt, houseNumber }) {
  const { month, year } = monthYearLabel(receipt.periodMonth);
  const amountWords = amountInWords(receipt.amount);
  const statusColor = STATUS_COLOR[receipt.status] || INK;

  return (
    <View style={styles.receipt}>
      {receipt.status === 'Rejected' ? (
        <Text style={styles.watermark}>NOT VALID</Text>
      ) : null}

      <View style={styles.masthead}>
        <Text style={[styles.centerText, styles.societyName]}>{receipt.societyName}</Text>
      </View>
      <View style={styles.masthead}>
        <Text style={[styles.centerText, styles.societyAddress]}>{SOCIETY_ADDRESS}</Text>
      </View>
      <View style={[styles.masthead, styles.mastheadLast]}>
        <Text style={[styles.centerText, styles.receiptTitle]}>RECEIPT</Text>
      </View>

      <View style={styles.gridTop}>
        <SplitRow
          left={<>Mob No <Text style={styles.bold}>{receipt.residentMobile || '\u2014'}</Text></>}
          right={<>Date <Text style={styles.bold}>{formatDate(receipt.date)}</Text></>}
        />
        <SplitRow
          leftFlex={1.4}
          left={<>Received From Mr/Mrs/Miss <Text style={styles.bold}>{receipt.residentName}</Text></>}
          right={<>H No / Flat No <Text style={styles.bold}>{houseNumber}</Text></>}
        />
        <GridRow>
          On the account of Monthly Society Maintenance for the month of{' '}
          <Text style={styles.bold}>{month} {year}</Text>
        </GridRow>
        <GridRow>
          Sum of INR <Text style={styles.bold}>{formatMoney(receipt.amount)}</Text>{' '}
          <Text style={styles.italic}>({amountWords})</Text>
        </GridRow>
        <View style={styles.checkboxRow}>
          <Text style={[styles.gridRowText, { marginRight: 10 }]}>By</Text>
          {PAYMENT_MODES.map((mode) => (
            <View key={mode.value} style={styles.checkboxItem}>
              <View style={styles.checkboxBox}>
                <Text style={styles.checkboxTick}>{mode.value === receipt.paymentMode ? '\u2713' : ''}</Text>
              </View>
              <Text style={styles.checkboxLabel}>{mode.label}</Text>
            </View>
          ))}
        </View>
        <GridRow last={receipt.status !== 'Rejected'}>
          Ref No <Text style={styles.bold}>{receipt.refNo || '\u2014'}</Text>
        </GridRow>
        {receipt.status === 'Rejected' ? (
          <GridRow last>
            <Text style={styles.bold}>Reason for rejection:</Text> {receipt.rejectionReason || '\u2014'}
          </GridRow>
        ) : null}
      </View>

      <View style={styles.footer}>
        <Text style={styles.footerStatus}>
          Status: <Text style={{ color: statusColor }}>{receipt.status}</Text>
        </Text>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={styles.footerCaption}>Received By</Text>
          <Text style={styles.receivedByName}>{receipt.receivedBy || '\u2014'}</Text>
          <Text style={styles.footerCaption}>Treasurer / Sub Treasurer</Text>
        </View>
      </View>
    </View>
  );
}

// Resident-facing receipt for exactly ONE billing period, reached from the
// "View Receipt" link on BillingHistoryScreen. A bulk payment covering
// several months produces one of these per period, each showing only that
// period's own allocated amount - never a combined multi-month document
// (see canvases/maintenance-receipt-mockup.canvas.tsx's own callout on this,
// settled directly with the user).
export default function MaintenanceReceiptScreen({ house, periodId, onBack }) {
  const { accessToken } = useAuth();
  const [receipt, setReceipt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    try {
      setError(null);
      const data = await apiGet(`/houses/${house.id}/billing-periods/${periodId}/receipt`, accessToken);
      setReceipt(data);
    } catch (err) {
      setError(err.message);
    }
  }, [accessToken, house.id, periodId]);

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, [load]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const html = buildReceiptHtml({ receipt, houseNumber: house.house_number });
      if (Platform.OS === 'web') {
        // Same hidden-iframe print technique as MonthEndClosingScreen/
        // PendencyReportScreen's own handleExport.
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
          await Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle: 'Share receipt' });
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
          <Text style={styles.title}>Receipt</Text>
          <Text style={styles.subtitle}>{house.house_number}</Text>
        </View>
        {onBack ? (
          <TouchableOpacity onPress={onBack}>
            <Text style={styles.backLink}>Back</Text>
          </TouchableOpacity>
        ) : null}
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
          <View style={styles.receiptWrap}>
            <ReceiptCard receipt={receipt} houseNumber={house.house_number} />
          </View>

          <TouchableOpacity
            style={[styles.exportButton, exporting && styles.exportButtonDisabled]}
            onPress={handleExport}
            disabled={exporting}
          >
            {exporting ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.exportButtonText}>Export as PDF / Share</Text>
            )}
          </TouchableOpacity>
          {Platform.OS === 'web' ? (
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
    backgroundColor: '#f5f6f8',
  },
  content: {
    padding: 20,
    paddingBottom: 40,
    alignItems: 'stretch',
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
    marginBottom: 20,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
  },
  subtitle: {
    fontSize: 14,
    color: '#555',
    marginTop: 4,
  },
  backLink: {
    color: '#1a73e8',
    fontSize: 14,
    fontWeight: '600',
    paddingTop: 4,
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
  receiptWrap: {
    alignItems: 'center',
    marginBottom: 20,
  },

  // --- The receipt document itself: strictly monochrome black-on-white,
  // same palette/structure as canvases/maintenance-receipt-mockup.canvas.tsx
  // (approved design) - every leaf Text sets its own color explicitly,
  // never inherited, so it renders identically regardless of the app's own
  // theme. ---
  receipt: {
    width: '100%',
    maxWidth: 480,
    backgroundColor: '#ffffff',
    borderWidth: 2,
    borderColor: '#000000',
    borderRadius: 18,
    overflow: 'hidden',
    position: 'relative',
  },
  watermark: {
    position: 'absolute',
    top: 90,
    left: 30,
    right: 30,
    textAlign: 'center',
    fontSize: 42,
    fontWeight: '700',
    color: '#b3261e',
    opacity: 0.22,
    letterSpacing: 4,
    transform: [{ rotate: '-16deg' }],
    zIndex: 1,
  },
  masthead: {
    paddingVertical: 5,
    paddingHorizontal: 12,
  },
  mastheadLast: {
    borderBottomWidth: 0,
  },
  centerText: {
    textAlign: 'center',
    color: INK,
  },
  societyName: {
    fontWeight: '700',
    fontSize: 14.5,
  },
  societyAddress: {
    fontSize: 11.5,
  },
  receiptTitle: {
    fontWeight: '700',
    fontSize: 12.5,
    letterSpacing: 2,
  },
  gridTop: {
    borderTopWidth: 1,
    borderTopColor: '#000000',
  },
  gridRow: {
    borderBottomWidth: 1,
    borderBottomColor: RULE_LIGHT,
    paddingVertical: 7,
    paddingHorizontal: 12,
  },
  noBorder: {
    borderBottomWidth: 0,
  },
  gridRowText: {
    fontSize: 12.5,
    color: INK,
    lineHeight: 18,
  },
  splitRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: RULE_LIGHT,
  },
  splitCell: {
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  bold: {
    fontWeight: '700',
    color: INK,
  },
  italic: {
    fontStyle: 'italic',
    color: INK,
  },
  checkboxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'nowrap',
    borderBottomWidth: 1,
    borderBottomColor: RULE_LIGHT,
    paddingVertical: 5,
    paddingHorizontal: 12,
  },
  checkboxItem: {
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 16,
  },
  checkboxBox: {
    width: 13,
    height: 13,
    borderWidth: 1.4,
    borderColor: INK,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 5,
  },
  checkboxTick: {
    fontSize: 10,
    fontWeight: '700',
    color: INK,
    lineHeight: 12,
  },
  checkboxLabel: {
    fontSize: 12,
    color: INK,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    paddingTop: 14,
    paddingBottom: 12,
    paddingHorizontal: 12,
    borderTopWidth: 1,
    borderTopColor: '#000000',
  },
  footerStatus: {
    fontSize: 11,
    fontWeight: '700',
    color: INK,
  },
  footerCaption: {
    fontSize: 11,
    color: INK,
  },
  receivedByName: {
    fontSize: 12,
    fontWeight: '700',
    color: INK,
    marginTop: 14,
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
  },
});
