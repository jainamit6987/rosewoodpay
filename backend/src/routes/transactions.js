const express = require('express');
const authenticate = require('../middleware/authenticate');

const router = express.Router();

// Postgres error codes we translate into specific HTTP responses instead of
// a generic 500, so the mobile client can show the resident something
// useful instead of "something went wrong".
const PG_UNIQUE_VIOLATION = '23505';
const PG_FOREIGN_KEY_VIOLATION = '23503';
const PG_INSUFFICIENT_PRIVILEGE = '42501';

router.post('/', authenticate, async (req, res) => {
  const { house_id, billing_period_id, amount, utr_number, raw_shared_payload, proof_file_path, txn_date } =
    req.body || {};

  if (!house_id || !billing_period_id || amount === undefined || amount === null) {
    return res.status(400).json({ error: 'house_id, billing_period_id, and amount are required.' });
  }

  if (typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number.' });
  }

  if (!utr_number && !raw_shared_payload && !proof_file_path) {
    return res
      .status(400)
      .json({ error: 'At least one of utr_number, raw_shared_payload, or proof_file_path is required.' });
  }

  const supabase = req.supabase;

  // society_id is derived from the house, never trusted from the request
  // body, so a caller cannot submit into a society they are not a member of.
  const { data: house, error: houseError } = await supabase
    .from('houses')
    .select('id, society_id')
    .eq('id', house_id)
    .maybeSingle();

  if (houseError) {
    return res.status(500).json({ error: houseError.message });
  }
  if (!house) {
    return res.status(404).json({ error: 'House not found or not accessible.' });
  }

  const { data: transaction, error: insertError } = await supabase
    .from('transactions')
    .insert({
      society_id: house.society_id,
      house_id,
      billing_period_id,
      submitted_by: req.user.id,
      amount,
      utr_number: utr_number || null,
      raw_shared_payload: raw_shared_payload || null,
      proof_file_path: proof_file_path || null,
      txn_date: txn_date || null,
    })
    .select()
    .single();

  if (insertError) {
    if (insertError.code === PG_UNIQUE_VIOLATION) {
      return res.status(409).json({ error: 'This UTR has already been submitted for this society.' });
    }
    if (insertError.code === PG_FOREIGN_KEY_VIOLATION) {
      return res.status(400).json({ error: 'billing_period_id does not reference a valid, matching billing period.' });
    }
    if (insertError.code === PG_INSUFFICIENT_PRIVILEGE || insertError.message?.includes('row-level security')) {
      return res.status(403).json({
        error:
          'Not allowed to submit for this house/billing period. It must be an approved, active house assignment and an open billing period.',
      });
    }
    return res.status(500).json({ error: insertError.message });
  }

  res.status(201).json(transaction);
});

module.exports = router;
