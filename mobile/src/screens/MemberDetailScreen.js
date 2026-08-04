import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { apiGet, apiPatch, apiPost } from '../api/client';
import { useAuth } from '../context/AuthContext';

function formatDate(value) {
  return new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function statusBadgeStyle(status) {
  if (status === 'Active') return styles.badgeActive;
  if (status === 'Suspended') return styles.badgeInactive;
  return styles.badgeUnknown;
}

function statusTextStyle(status) {
  if (status === 'Active') return styles.badgeTextActive;
  if (status === 'Suspended') return styles.badgeTextInactive;
  return styles.badgeTextUnknown;
}

// Same as HouseDashboardScreen's own detailRow list further down - a
// house's own current standing (Active/Pending/Revoked assignment).
function assignmentStatusTextStyle(status) {
  if (status === 'Active') return styles.badgeTextActive;
  if (status === 'Revoked') return styles.badgeTextInactive;
  return styles.badgeTextUnknown; // Pending
}

// GET /members/:id (backend/src/routes/members.js) - the single-member
// counterpart to MembersScreen's search results, reached either from
// there or (once built) from a resident card on the House Dashboard. Does
// its own live fetch off member.id rather than trusting whatever object
// its caller passed in, same "the detail screen is the source of truth"
// precedent as HouseDashboardScreen. Edit mode covers name/phone_number/
// roles (PATCH /members/:id); Suspend/Reactivate are their own dedicated
// actions below that, mirroring AdminReviewScreen's verify (immediate) vs
// reject (inline confirm) asymmetry - Reactivate applies right away,
// Suspend needs an explicit inline confirmation first since it disables
// the member's login outright.
export default function MemberDetailScreen({ member, onBack }) {
  const { accessToken } = useAuth();
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editIsAdmin, setEditIsAdmin] = useState(false);
  const [editIsCommitteeMember, setEditIsCommitteeMember] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState(null);

  const [confirmingSuspend, setConfirmingSuspend] = useState(false);
  const [statusActionBusy, setStatusActionBusy] = useState(false);
  const [statusActionError, setStatusActionError] = useState(null);

  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetError, setResetError] = useState(null);
  const [resetTempPassword, setResetTempPassword] = useState(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const data = await apiGet(`/members/${member.id}`, accessToken);
      setDetail(data);
    } catch (err) {
      setError(err.message);
    }
  }, [accessToken, member.id]);

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, [load]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const startEdit = () => {
    setEditName(detail.name || '');
    setEditPhone(detail.phoneNumber || '');
    setEditIsAdmin(detail.isAdmin);
    setEditIsCommitteeMember(detail.isCommitteeMember);
    setEditError(null);
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setEditError(null);
  };

  const saveEdit = async () => {
    setEditError(null);
    if (!editName.trim()) {
      setEditError("Name can't be empty.");
      return;
    }
    setSavingEdit(true);
    try {
      const updated = await apiPatch(`/members/${member.id}`, accessToken, {
        name: editName.trim(),
        phone_number: editPhone.trim() || null,
        is_admin: editIsAdmin,
        is_committee_member: editIsCommitteeMember,
      });
      setDetail((prev) => ({ ...prev, ...updated }));
      setEditing(false);
    } catch (err) {
      setEditError(err.message);
    } finally {
      setSavingEdit(false);
    }
  };

  const handleReactivate = async () => {
    setStatusActionError(null);
    setStatusActionBusy(true);
    try {
      const updated = await apiPost(`/members/${member.id}/reactivate`, accessToken);
      setDetail((prev) => ({ ...prev, ...updated }));
    } catch (err) {
      setStatusActionError(err.message);
    } finally {
      setStatusActionBusy(false);
    }
  };

  const confirmSuspend = async () => {
    setStatusActionError(null);
    setStatusActionBusy(true);
    try {
      const updated = await apiPost(`/members/${member.id}/suspend`, accessToken);
      setDetail((prev) => ({ ...prev, ...updated }));
      setConfirmingSuspend(false);
    } catch (err) {
      // Surfaces the backend's own message as-is - e.g. the "still has an
      // Active house assignment" 400 already names the house and tells
      // the Admin exactly what to go fix first (see routes/members.js).
      setStatusActionError(err.message);
    } finally {
      setStatusActionBusy(false);
    }
  };

  // Admin-facing "they forgot their password" recovery path (POST
  // /members/:id/reset-password) - there is no email/SMTP provider
  // configured in this project, so this is the interim substitute: a
  // fresh temp password, shown here once and never stored/logged
  // anywhere, for the Admin to hand over directly - same shape as
  // CreateMemberScreen's own account-creation temp password.
  const confirmReset = async () => {
    setResetError(null);
    setResetBusy(true);
    try {
      const result = await apiPost(`/members/${member.id}/reset-password`, accessToken);
      setResetTempPassword(result.temporaryPassword);
      setConfirmingReset(false);
    } catch (err) {
      setResetError(err.message);
    } finally {
      setResetBusy(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (error || !detail) {
    return (
      <View style={styles.centered}>
        <Text style={styles.error}>{error || 'Could not load this member.'}</Text>
        <TouchableOpacity style={styles.retryButton} onPress={handleRefresh}>
          <Text style={styles.retryButtonText}>Retry</Text>
        </TouchableOpacity>
        {onBack ? (
          <TouchableOpacity onPress={onBack}>
            <Text style={styles.backLinkText}>← Back</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
    >
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{detail.name || 'Unnamed member'}</Text>
          <Text style={styles.subtitle}>Member detail</Text>
        </View>
        <View style={[styles.badge, statusBadgeStyle(detail.status)]}>
          <Text style={[styles.badgeText, statusTextStyle(detail.status)]}>{detail.status}</Text>
        </View>
      </View>

      {onBack ? (
        <TouchableOpacity style={styles.backLink} onPress={onBack}>
          <Text style={styles.backLinkText}>← Back to Members</Text>
        </TouchableOpacity>
      ) : null}

      {editing ? (
        <View style={styles.card}>
          <Text style={styles.label}>Name</Text>
          <TextInput style={styles.input} value={editName} onChangeText={setEditName} editable={!savingEdit} />

          <Text style={styles.label}>Mobile Number</Text>
          <TextInput
            style={styles.input}
            value={editPhone}
            onChangeText={setEditPhone}
            keyboardType="phone-pad"
            placeholder="Not set"
            editable={!savingEdit}
          />

          <Text style={styles.label}>Role</Text>
          <View style={styles.roleRow}>
            <TouchableOpacity
              style={[styles.roleChip, editIsAdmin && styles.roleChipActive]}
              onPress={() => setEditIsAdmin((v) => !v)}
              disabled={savingEdit}
            >
              <Text style={[styles.roleChipText, editIsAdmin && styles.roleChipTextActive]}>Admin</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.roleChip, editIsCommitteeMember && styles.roleChipActive]}
              onPress={() => setEditIsCommitteeMember((v) => !v)}
              disabled={savingEdit}
            >
              <Text style={[styles.roleChipText, editIsCommitteeMember && styles.roleChipTextActive]}>Committee</Text>
            </TouchableOpacity>
          </View>

          {editError ? <Text style={styles.error}>{editError}</Text> : null}

          <View style={styles.actionRow}>
            <TouchableOpacity style={styles.cancelButton} onPress={cancelEdit} disabled={savingEdit}>
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.saveButton} onPress={saveEdit} disabled={savingEdit}>
              <Text style={styles.saveButtonText}>{savingEdit ? 'Saving…' : 'Save'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        <View style={styles.card}>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Email</Text>
            <Text style={styles.detailValue}>{detail.email || '\u2014'}</Text>
          </View>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Mobile Number</Text>
            <Text style={styles.detailValue}>{detail.phoneNumber || '\u2014'}</Text>
          </View>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Role</Text>
            <Text style={styles.detailValue}>
              {[detail.isAdmin && 'Admin', detail.isCommitteeMember && 'Committee'].filter(Boolean).join(' \u00b7 ') || 'Resident'}
            </Text>
          </View>
          <View style={[styles.detailRow, styles.detailRowLast]}>
            <Text style={styles.detailLabel}>Member since</Text>
            <Text style={styles.detailValue}>{formatDate(detail.createdAt)}</Text>
          </View>

          <TouchableOpacity style={styles.editLink} onPress={startEdit}>
            <Text style={styles.editLinkText}>Edit details</Text>
          </TouchableOpacity>
        </View>
      )}

      <Text style={styles.sectionHeader}>House Assignments</Text>
      {detail.assignments.length === 0 ? (
        <Text style={styles.hint}>Not linked to any house.</Text>
      ) : (
        detail.assignments.map((assignment) => (
          <View key={assignment.id} style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.houseNumber}>{assignment.houseNumber}</Text>
              <View style={[styles.badge, statusBadgeStyle(assignment.status === 'Active' ? 'Active' : 'Suspended')]}>
                <Text style={[styles.badgeText, assignmentStatusTextStyle(assignment.status)]}>{assignment.status}</Text>
              </View>
            </View>
            <View style={[styles.detailRow, styles.detailRowLast]}>
              <Text style={styles.detailLabel}>Relationship</Text>
              <Text style={styles.detailValue}>{assignment.relationshipType}</Text>
            </View>
          </View>
        ))
      )}

      <Text style={styles.sectionHeader}>Account</Text>
      <View style={styles.card}>
        {resetTempPassword ? (
          <View style={styles.tempPasswordBox}>
            <Text style={styles.tempPasswordLabel}>New temporary password (shown only once)</Text>
            <Text style={styles.tempPasswordValue}>{resetTempPassword}</Text>
            <Text style={styles.tempPasswordHint}>
              Share this with {detail.name || 'the member'} directly - it will not be shown again. Their previous
              password no longer works.
            </Text>
            <TouchableOpacity style={styles.saveButton} onPress={() => setResetTempPassword(null)}>
              <Text style={styles.saveButtonText}>Done</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            {resetError ? <Text style={styles.error}>{resetError}</Text> : null}
            {confirmingReset ? (
              <View>
                <Text style={styles.confirmText}>
                  This generates a new temporary password and immediately invalidates {detail.name || 'their'}{' '}
                  current one. Continue?
                </Text>
                <View style={styles.actionRow}>
                  <TouchableOpacity
                    style={styles.cancelButton}
                    onPress={() => setConfirmingReset(false)}
                    disabled={resetBusy}
                  >
                    <Text style={styles.cancelButtonText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.saveButton} onPress={confirmReset} disabled={resetBusy}>
                    <Text style={styles.saveButtonText}>{resetBusy ? 'Resetting…' : 'Confirm reset'}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              <TouchableOpacity
                style={styles.resetOutlineButton}
                onPress={() => setConfirmingReset(true)}
                disabled={resetBusy}
              >
                <Text style={styles.resetOutlineButtonText}>Reset Password</Text>
              </TouchableOpacity>
            )}
            <View style={styles.divider} />
          </>
        )}

        {statusActionError ? <Text style={styles.error}>{statusActionError}</Text> : null}

        {detail.status === 'Suspended' ? (
          <TouchableOpacity style={styles.reactivateButton} onPress={handleReactivate} disabled={statusActionBusy}>
            <Text style={styles.reactivateButtonText}>{statusActionBusy ? 'Reactivating…' : 'Reactivate Member'}</Text>
          </TouchableOpacity>
        ) : confirmingSuspend ? (
          <View>
            <Text style={styles.confirmText}>
              This will disable {detail.name || 'this member'}'s login immediately. Continue?
            </Text>
            <View style={styles.actionRow}>
              <TouchableOpacity
                style={styles.cancelButton}
                onPress={() => setConfirmingSuspend(false)}
                disabled={statusActionBusy}
              >
                <Text style={styles.cancelButtonText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.suspendButton} onPress={confirmSuspend} disabled={statusActionBusy}>
                <Text style={styles.suspendButtonText}>{statusActionBusy ? 'Suspending…' : 'Confirm suspend'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <TouchableOpacity
            style={styles.suspendOutlineButton}
            onPress={() => setConfirmingSuspend(true)}
            disabled={statusActionBusy}
          >
            <Text style={styles.suspendOutlineButtonText}>Suspend Member</Text>
          </TouchableOpacity>
        )}
      </View>
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
    backgroundColor: '#f5f5f7',
    padding: 24,
    gap: 16,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 8,
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
    marginBottom: 16,
  },
  backLinkText: {
    color: '#1a73e8',
    fontSize: 14,
    fontWeight: '600',
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  houseNumber: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1c1c1e',
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  detailRowLast: {
    borderBottomWidth: 0,
  },
  detailLabel: {
    fontSize: 13,
    color: '#6e6e73',
  },
  detailValue: {
    fontSize: 13,
    fontWeight: '600',
    color: '#1c1c1e',
  },
  editLink: {
    marginTop: 12,
    alignItems: 'flex-start',
  },
  editLinkText: {
    color: '#1a73e8',
    fontSize: 13,
    fontWeight: '600',
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: '#333',
    marginBottom: 6,
  },
  input: {
    borderWidth: 1,
    borderColor: '#d0d0d0',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    marginBottom: 14,
  },
  roleRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 14,
  },
  roleChip: {
    borderWidth: 1,
    borderColor: '#d0d0d0',
    borderRadius: 20,
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  roleChipActive: {
    backgroundColor: '#e8f0fe',
    borderColor: '#1a73e8',
  },
  roleChipText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#6e6e73',
  },
  roleChipTextActive: {
    color: '#1a73e8',
  },
  actionRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    marginTop: 4,
  },
  cancelButton: {
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  cancelButtonText: {
    color: '#777',
    fontSize: 14,
    fontWeight: '600',
  },
  saveButton: {
    backgroundColor: '#1a73e8',
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 20,
  },
  saveButtonText: {
    color: '#fff',
    fontWeight: '600',
  },
  sectionHeader: {
    fontSize: 12,
    fontWeight: '700',
    color: '#8a8a8e',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 4,
    marginBottom: 8,
  },
  hint: {
    fontSize: 13,
    color: '#6e6e73',
    marginBottom: 16,
  },
  confirmText: {
    fontSize: 14,
    color: '#1c1c1e',
    marginBottom: 12,
  },
  suspendOutlineButton: {
    borderWidth: 1,
    borderColor: '#c0392b',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  suspendOutlineButtonText: {
    color: '#c0392b',
    fontWeight: '600',
    fontSize: 15,
  },
  suspendButton: {
    backgroundColor: '#c0392b',
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 20,
  },
  suspendButtonText: {
    color: '#fff',
    fontWeight: '600',
  },
  resetOutlineButton: {
    borderWidth: 1,
    borderColor: '#1a73e8',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  resetOutlineButtonText: {
    color: '#1a73e8',
    fontWeight: '600',
    fontSize: 15,
  },
  divider: {
    height: 1,
    backgroundColor: '#f0f0f0',
    marginVertical: 14,
  },
  tempPasswordBox: {
    backgroundColor: '#f5f6f8',
    borderRadius: 8,
    padding: 16,
    alignItems: 'center',
  },
  tempPasswordLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#333',
    marginBottom: 6,
  },
  tempPasswordValue: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1a73e8',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  tempPasswordHint: {
    fontSize: 12,
    color: '#777',
    textAlign: 'center',
    marginBottom: 12,
  },
  reactivateButton: {
    backgroundColor: '#2e7d32',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  reactivateButtonText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 15,
  },
  error: {
    color: '#c0392b',
    fontSize: 14,
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
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    marginLeft: 8,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  badgeActive: {
    backgroundColor: '#e6f4ea',
  },
  badgeTextActive: {
    color: '#2e7d32',
  },
  badgeInactive: {
    backgroundColor: '#fdecea',
  },
  badgeTextInactive: {
    color: '#c0392b',
  },
  badgeUnknown: {
    backgroundColor: '#eee',
  },
  badgeTextUnknown: {
    color: '#666',
  },
});
