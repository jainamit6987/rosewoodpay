// Web counterpart to DateField.js. @react-native-community/datetimepicker
// has no web support at all (confirmed against its own docs - it only
// lists android/ios/expo-go as supported platforms), so this uses a plain
// HTML <input type="date"> instead - a real native browser date picker,
// no extra dependency needed. Metro's platform-extension resolution picks
// this file over DateField.js whenever bundling for web, so the
// unsupported native package is never even pulled into the web bundle.
// Same value/onChange contract as the native file: value is a plain JS
// Date, onChange receives a plain JS Date back.
//
// Deliberately built from `date.getFullYear()/getMonth()/getDate()` (local
// components), never `toISOString()` (UTC) - an ISO conversion can roll a
// date back or forward a day for anyone west/east of UTC, the same class
// of bug already worked around elsewhere in this app (see
// PendencyReportScreen's own date-only parsing comment).
function toInputValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function fromInputValue(value) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

export default function DateField({ value, onChange, minimumDate, maximumDate, disabled }) {
  return (
    <input
      type="date"
      value={toInputValue(value)}
      min={minimumDate ? toInputValue(minimumDate) : undefined}
      max={maximumDate ? toInputValue(maximumDate) : undefined}
      disabled={disabled}
      onChange={(e) => {
        if (e.target.value) {
          onChange(fromInputValue(e.target.value));
        }
      }}
      style={{
        borderWidth: 1,
        borderColor: '#d0d0d0',
        borderRadius: 8,
        paddingTop: 12,
        paddingBottom: 12,
        paddingLeft: 14,
        paddingRight: 14,
        fontSize: 16,
        color: '#1c1c1e',
        fontFamily: 'inherit',
        backgroundColor: disabled ? '#f0f0f0' : '#fff',
        opacity: disabled ? 0.6 : 1,
      }}
    />
  );
}
