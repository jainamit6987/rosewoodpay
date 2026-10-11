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
import { ReceiptCard, buildReceiptHtml } from '../components/ReceiptDocument';

// Resident-facing receipt for exactly ONE WaterCharge transaction, reached
// from the "View Receipt" link on WaterChargeScreen's own history list.
// Unlike MaintenanceReceiptScreen (one receipt per billing period, which a
// single payment can span several of), WaterCharge is "pay-as-you-go" with
// no billing_periods row behind it at all (see
// 20260803000000_add_water_charge_transaction_type.sql) - each transaction
// IS the whole thing to show a receipt for, one-to-one, so this is scoped
// by transactionId rather than periodId.
//
// Shown for a transaction in ANY processing_status (Submitted, Verified,
// or Rejected), same as the Maintenance receipt's own three-state
// behavior (Pending Approval / Approved / Rejected, with its reason and a
// "NOT VALID" watermark) - see GET /:houseId/transactions/:transactionId/
// receipt's own comment on this.
//
// The receipt document itself (<ReceiptCard/>/buildReceiptHtml) is shared
// with MaintenanceReceiptScreen - see components/ReceiptDocument.js. This
// screen's only job on top of that shared piece is fetching this specific
// transaction's receipt data and building the "on account of" line from
// its (optional) free-text description instead of a billing period month.
export default function WaterChargeReceiptScreen({ house, transactionId, onBack }) {
  const { accessToken } = useAuth();
  const [receipt, setReceipt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    try {
      setError(null);
      const data = await apiGet(`/houses/${house.id}/transactions/${transactionId}/receipt`, accessToken);
      setReceipt(data);
    } catch (err) {
      setError(err.message);
    }
  }, [accessToken, house.id, transactionId]);

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, [load]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const accountLine = receipt ? `Water Charges${receipt.description ? ` - ${receipt.description}` : ''}` : '';

  const handleExport = async () => {
    setExporting(true);
    try {
      const html = buildReceiptHtml({ receipt, houseNumber: house.house_number, accountLine });
      if (Platform.OS === 'web') {
        // Same hidden-iframe print technique as MaintenanceReceiptScreen/
        // MonthEndClosingScreen/PendencyReportScreen's own handleExport.
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
            <ReceiptCard receipt={receipt} houseNumber={house.house_number} accountLine={accountLine} />
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
