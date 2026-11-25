import React from 'react';
import {StyleSheet, View, ScrollView} from 'react-native';
import {Button, Switch, Text, useTheme} from 'react-native-paper';
import {useTranslation} from 'react-i18next';
import Slider from '@react-native-community/slider';
import {getSettings, saveSettings} from '../store/settingStore';
import {
  GTA6_TUNING,
  Gta6Tuning,
  normaliseTuning,
} from '../triggers/gta6Profile';

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
  const [tuning, setTuning] = React.useState<Gta6Tuning>(() =>
    normaliseTuning(getSettings().gta6_trigger_tuning),
  );

  // Every change is saved straight away, so a running stream picks it up.
  const save = (nextEnabled: boolean, nextTuning: Gta6Tuning) => {
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

      <Button
        mode="outlined"
        style={styles.reset}
        onPress={() => save(enabled, normaliseTuning())}>
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
