import { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity } from 'react-native';
import RNDateTimePicker from '@react-native-community/datetimepicker';

function formatDisplay(date) {
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

// Native (iOS/Android) counterpart to DateField.web.js - Metro picks
// whichever of the two matches the build platform, so this file never
// gets bundled for web at all (where @react-native-community/
// datetimepicker isn't supported - see that file's own comment). Both
// sides share the same value/onChange contract: value is a plain JS Date,
// onChange receives a plain JS Date back. `display="default"` renders the
// platform's own native modal/dialog on both iOS and Android and
// self-dismisses on pick or cancel, so no extra Modal/Done-button
// wrapper is needed here.
export default function DateField({ value, onChange, minimumDate, maximumDate, disabled }) {
  const [showPicker, setShowPicker] = useState(false);

  return (
    <>
      <TouchableOpacity
        style={[styles.field, disabled && styles.fieldDisabled]}
        onPress={() => setShowPicker(true)}
        disabled={disabled}
      >
        <Text style={styles.fieldText}>{formatDisplay(value)}</Text>
      </TouchableOpacity>
      {showPicker ? (
        <RNDateTimePicker
          value={value}
          mode="date"
          display="default"
          minimumDate={minimumDate}
          maximumDate={maximumDate}
          onChange={(event, selectedDate) => {
            setShowPicker(false);
            if (event.type === 'set' && selectedDate) {
              onChange(selectedDate);
            }
          }}
        />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  field: {
    borderWidth: 1,
    borderColor: '#d0d0d0',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  fieldDisabled: {
    opacity: 0.6,
  },
  fieldText: {
    fontSize: 16,
    color: '#1c1c1e',
  },
});
