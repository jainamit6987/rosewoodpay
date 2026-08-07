// Converts a whole-rupee amount into the Indian numbering system's words
// (Lakh/Crore, not Million/Billion) - built from scratch for the
// Maintenance Receipt feature's "Sum of INR ___ (Rupees ___ Only)" line;
// no such helper existed anywhere in this codebase before (mobile or
// backend). Maintenance amounts are always whole-rupee multiples of a
// house's base rate (see the "Base-amount-multiple rule" in
// backend/src/routes/transactions.js), so paise are never expected here,
// but any fractional part is still rendered as "X Rupees and Y Paise" for
// safety rather than silently dropped.
const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
  'Seventeen', 'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function threeDigitsToWords(value) {
  const parts = [];
  if (value >= 100) {
    parts.push(`${ONES[Math.floor(value / 100)]} Hundred`);
    value %= 100;
  }
  if (value >= 20) {
    const tensPart = TENS[Math.floor(value / 10)];
    const onesPart = ONES[value % 10];
    parts.push(onesPart ? `${tensPart} ${onesPart}` : tensPart);
  } else if (value > 0) {
    parts.push(ONES[value]);
  }
  return parts.join(' ');
}

// Indian grouping after the first three digits is by hundreds (2 digits at
// a time): ...,XX,XX,XXX - Thousand, then Lakh, then Crore.
const INDIAN_PLACES = [
  { divisor: 10000000, label: 'Crore' },
  { divisor: 100000, label: 'Lakh' },
  { divisor: 1000, label: 'Thousand' },
];

function wholeRupeesToWords(whole) {
  if (whole === 0) return 'Zero';
  let remaining = whole;
  const parts = [];
  for (const { divisor, label } of INDIAN_PLACES) {
    const count = Math.floor(remaining / divisor);
    if (count > 0) {
      parts.push(`${threeDigitsToWords(count)} ${label}`);
      remaining %= divisor;
    }
  }
  if (remaining > 0) {
    parts.push(threeDigitsToWords(remaining));
  }
  return parts.join(' ');
}

// amountInWords(3000) -> "Rupees Three Thousand Only"
// amountInWords(3450.50) -> "Rupees Three Thousand Four Hundred Fifty and 50 Paise Only"
export function amountInWords(amount) {
  const numeric = Number(amount) || 0;
  const whole = Math.floor(Math.abs(numeric));
  const paise = Math.round((Math.abs(numeric) - whole) * 100);

  const wholeWords = wholeRupeesToWords(whole);
  if (paise > 0) {
    return `Rupees ${wholeWords} and ${paise} Paise Only`;
  }
  return `Rupees ${wholeWords} Only`;
}
