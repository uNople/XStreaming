import React from 'react';
import {StyleSheet, View, ScrollView} from 'react-native';
import {Button, RadioButton, Switch, Text, useTheme} from 'react-native-paper';
import {useTranslation} from 'react-i18next';
import Slider from '@react-native-community/slider';
import {getSettings, saveSettings} from '../store/settingStore';
import {
  GTA6_TUNING,
  Gta6Tuning,
  normaliseTuning,
} from '../triggers/gta6Profile';
import {
  MOTION_TUNING,
  MotionTuning,
  normaliseMotionTuning,
} from '../triggers/motionAim';

const GROUPS: {id: 'foot' | 'vehicle'; title: string}[] = [
  {id: 'foot', title: 'On foot'},
  {id: 'vehicle', title: 'In a vehicle'},
];

const describe = (max: number, value: number) => {
  if (max === 100) {
    return `${value}%`;
  }
  return value === 0 ? 'Off' : String(value);
};

function Gta6TriggersScreen() {
  const {t} = useTranslation();
  const theme = useTheme();

  const [enabled, setEnabled] = React.useState(
    () => !!getSettings().gta6_triggers,
  );
  // Trigger and motion values are kept together in one saved object.
  const [tuning, setTuning] = React.useState<Gta6Tuning & MotionTuning>(() => ({
    ...normaliseTuning(getSettings().gta6_trigger_tuning),
    ...normaliseMotionTuning(getSettings().gta6_trigger_tuning as any),
  }));

  // Every change is saved straight away, so a running stream picks it up.
  const save = (
    nextEnabled: boolean,
    nextTuning: Gta6Tuning & MotionTuning,
  ) => {
    setEnabled(nextEnabled);
    setTuning(nextTuning);
    saveSettings({
      ...getSettings(),
      gta6_triggers: nextEnabled,
      gta6_trigger_tuning: nextTuning,
    });
  };

  return (
    <ScrollView style={styles.container}>
      <View style={styles.row}>
        <Text variant="titleMedium" style={styles.rowLabel}>
          {t('GTA 6 adaptive triggers')}
        </Text>
        <Switch value={enabled} onValueChange={value => save(value, tuning)} />
      </View>
      <Text variant="bodySmall" style={styles.note}>
        {t('gta6_triggers_note')}
      </Text>

      {GROUPS.map(group => (
        <View key={group.id}>
          <Text variant="titleMedium" style={styles.group}>
            {t(group.title)}
          </Text>
          {GTA6_TUNING.filter(item => item.group === group.id).map(item => (
            <View key={item.key}>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>{t(item.label)}</Text>
                <Text>{describe(item.max, tuning[item.key])}</Text>
              </View>
              <Slider
                style={styles.slider}
                value={tuning[item.key]}
                minimumValue={item.min}
                maximumValue={item.max}
                step={1}
                disabled={!enabled}
                onValueChange={value =>
                  save(enabled, {...tuning, [item.key]: value})
                }
                minimumTrackTintColor={theme.colors.primary}
                maximumTrackTintColor="grey"
              />
            </View>
          ))}
        </View>
      ))}

      <Text variant="titleMedium" style={styles.group}>
        {t('Motion aiming')}
      </Text>
      <Text variant="bodySmall" style={styles.note}>
        {t('gta6_motion_note')}
      </Text>
      {MOTION_TUNING.map(item => {
        const value = tuning[item.key];
        const change = (next: number) =>
          save(enabled, {...tuning, [item.key]: next});
        if (item.choices) {
          return (
            <View key={item.key}>
              <Text style={styles.rowLabel}>{t(item.label)}</Text>
              <RadioButton.Group
                value={String(value)}
                onValueChange={next => change(Number(next))}>
                {item.choices.map((choice, index) => (
                  <RadioButton.Item
                    key={choice}
                    label={t(choice)}
                    value={String(index)}
                  />
                ))}
              </RadioButton.Group>
            </View>
          );
        }
        if (item.max === 1) {
          return (
            <View key={item.key} style={styles.switchRow}>
              <Text style={styles.rowLabel}>{t(item.label)}</Text>
              <Switch
                value={!!value}
                onValueChange={on => change(on ? 1 : 0)}
              />
            </View>
          );
        }
        return (
          <View key={item.key}>
            <View style={styles.row}>
              <Text style={styles.rowLabel}>{t(item.label)}</Text>
              <Text>{`${value}${item.unit ?? '%'}`}</Text>
            </View>
            <Slider
              style={styles.slider}
              value={value}
              minimumValue={item.min}
              maximumValue={item.max}
              step={1}
              onValueChange={change}
              minimumTrackTintColor={theme.colors.primary}
              maximumTrackTintColor="grey"
            />
          </View>
        );
      })}

      <Button
        mode="outlined"
        style={styles.reset}
        onPress={() =>
          save(enabled, {...normaliseTuning(), ...normaliseMotionTuning()})
        }>
        {t('Reset to defaults')}
      </Button>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 16,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  rowLabel: {
    flex: 1,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginVertical: 6,
  },
  note: {
    marginTop: 4,
    marginBottom: 8,
  },
  group: {
    marginTop: 16,
    marginBottom: 8,
  },
  slider: {
    width: '100%',
    height: 40,
  },
  reset: {
    marginTop: 16,
    marginBottom: 32,
  },
});

export default Gta6TriggersScreen;
