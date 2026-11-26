import React from 'react';
import {StyleSheet, View, ScrollView} from 'react-native';
import {Button, RadioButton, Switch, Text, useTheme} from 'react-native-paper';
import {useTranslation} from 'react-i18next';
import Slider from '@react-native-community/slider';
import {getSettings, saveSettings, Settings} from '../store/settingStore';
import {GTA6_TUNING, normaliseTuning} from '../triggers/gta6Profile';
import {MOTION_TUNING, normaliseMotionTuning} from '../triggers/motionAim';
import {maxRumbleStrength, rumbleStrength} from '../utils/controllerRumble';

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

function ControllerTuning({maxHeight}: {maxHeight?: number}) {
  const {t} = useTranslation();
  const theme = useTheme();

  const [settings, setSettings] = React.useState(getSettings);
  const enabled = settings.gta6_triggers;
  const tuning = {
    ...normaliseTuning(settings.gta6_trigger_tuning),
    ...normaliseMotionTuning(settings.gta6_trigger_tuning),
  };
  const strength = rumbleStrength(settings);

  const save = (patch: Partial<Settings>) => {
    const next = {...getSettings(), ...patch};
    setSettings(next);
    saveSettings(next);
  };
  const setTuning = (key: keyof typeof tuning, value: number) =>
    save({
      gta6_trigger_tuning: {...getSettings().gta6_trigger_tuning, [key]: value},
    });

  return (
    <ScrollView style={maxHeight ? {maxHeight} : styles.container}>
      <View style={styles.switchRow}>
        <Text variant="titleMedium" style={styles.rowLabel}>
          {t('Controller rumble')}
        </Text>
        <Switch
          accessibilityLabel={t('Controller rumble')}
          value={settings.vibration}
          onValueChange={value => save({vibration: value})}
        />
      </View>
      <View style={styles.row}>
        <Text style={styles.rowLabel}>{t('Rumble strength')}</Text>
        <Text>{`${strength}%`}</Text>
      </View>
      <Slider
        accessibilityLabel={t('Rumble strength')}
        style={styles.slider}
        value={strength}
        minimumValue={0}
        maximumValue={maxRumbleStrength}
        step={1}
        onValueChange={value => save({rumble_strength: value})}
        minimumTrackTintColor={theme.colors.primary}
        maximumTrackTintColor="grey"
      />
      <View style={styles.switchRow}>
        <Text variant="titleMedium" style={styles.rowLabel}>
          {t('Motion aiming')}
        </Text>
        <Switch
          accessibilityLabel={t('Motion aiming')}
          value={!!tuning.motion_enabled}
          onValueChange={value => setTuning('motion_enabled', value ? 1 : 0)}
        />
      </View>
      <Text variant="bodySmall" style={styles.note}>
        {t('gta6_motion_note')}
      </Text>
      {MOTION_TUNING.filter(item => item.key !== 'motion_enabled').map(item => {
        const value = tuning[item.key];
        const change = (next: number) => setTuning(item.key, next);
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

      <View style={styles.row}>
        <Text variant="titleMedium" style={styles.rowLabel}>
          {t('GTA 6 adaptive triggers')}
        </Text>
        <Switch
          accessibilityLabel={t('GTA 6 adaptive triggers')}
          value={enabled}
          onValueChange={value => save({gta6_triggers: value})}
        />
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
                onValueChange={value => setTuning(item.key, value)}
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
        onPress={() =>
          save({
            rumble_strength: 100,
            gta6_trigger_tuning: {
              ...normaliseTuning(),
              ...normaliseMotionTuning(),
            },
          })
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

export default ControllerTuning;
