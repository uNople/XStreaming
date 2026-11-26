import React from 'react';
import {
  View,
  Alert,
  DeviceEventEmitter,
  NativeModules,
  Vibration,
  NativeEventEmitter,
  StyleSheet,
  ScrollView,
  Dimensions,
  ToastAndroid,
  Platform,
} from 'react-native';
import {
  Portal,
  Modal,
  Card,
  List,
  Button,
  IconButton,
  TextInput,
  Text,
} from 'react-native-paper';
import {WebView} from 'react-native-webview';
import Orientation from 'react-native-orientation-locker';
import RNRestart from 'react-native-restart';
import XcloudApi from '../xCloud';
import {useSelector} from 'react-redux';
import {
  getSettings,
  saveSettings,
  SETTINGS_CHANGED_EVENT,
} from '../store/settingStore';
import {
  gta6Rumble,
  startGta6Triggers,
  stopGta6Triggers,
} from '../triggers/gta6Ios';
import {useTranslation} from 'react-i18next';
import {debugFactory} from '../utils/debug';
import WebApi from '../web';
import VirtualGamepad from '../components/VirtualGamepad';
import CustomVirtualGamepad from '../components/CustomVirtualGamepad';
import PerfPanel from '../components/PerfPanel';
import Display from '../components/Display';
import ControllerTuning from './Gta6Triggers';
import {GAMEPAD_MAPING} from '../common';
import {controllerRumble, rumbleStrength} from '../utils/controllerRumble';
import {createGamepadOutput, gamepadButtons} from '../utils/gamepadOutput';

const log = debugFactory('StreamScreen');

const CONNECTED = 'connected';

const initialGamepadState = {
  A: 0,
  B: 0,
  X: 0,
  Y: 0,
  LeftShoulder: 0,
  RightShoulder: 0,
  LeftTrigger: 0,
  RightTrigger: 0,
  View: 0,
  Menu: 0,
  LeftThumb: 0,
  RightThumb: 0,
  DPadUp: 0,
  DPadDown: 0,
  DPadLeft: 0,
  DPadRight: 0,
  Nexus: 0,

  LeftThumbXAxis: 0.0,
  LeftThumbYAxis: 0.0,
  RightThumbXAxis: 0.0,
  RightThumbYAxis: 0.0,
};

const {GamepadManager} = NativeModules;

const eventEmitter = new NativeEventEmitter(GamepadManager);

const getPressedButtons = combinedValue => {
  const pressedButtons = [];
  for (const [button, value] of Object.entries(GAMEPAD_MAPING)) {
    // eslint-disable-next-line no-bitwise
    if ((combinedValue & value) === value) {
      pressedButtons.push(button);
    }
  }
  return pressedButtons;
};

function StreamScreen({navigation, route}) {
  const {t} = useTranslation();
  const authentication = useSelector(state => state.authentication);
  const streamingTokens = useSelector(state => state.streamingTokens);
  const webToken = useSelector(state => state.webToken);

  const [xHomeApi, setXHomeApi] = React.useState(null);
  const [xCloudApi, setXCloudApi] = React.useState(null);
  const [settings, setSettings] = React.useState({});
  const [isExiting, setIsExiting] = React.useState(false);
  const [showModal, setShowModal] = React.useState(false);
  const [showTipsModal, setShowTipsModal] = React.useState(false);
  const [hasController, setHasController] = React.useState(null);
  const [showWebview, setShowWebview] = React.useState(false);
  const [showDisplayModal, setShowDisplayModal] = React.useState(false);
  const [showControllerTuning, setShowControllerTuning] = React.useState(false);
  const [showMessageModal, setShowMessageModal] = React.useState(false);
  const [showVirtualGamepad, setShowVirtualGamepad] = React.useState(false);
  const [connectState, setConnectState] = React.useState('');
  const [performance, setPerformance] = React.useState({});
  const [showPerformance, setShowPerformance] = React.useState(false);
  const [needPoweroff, setNeedPoweroff] = React.useState(false);
  const [modalMaxHeight, setModalMaxHeight] = React.useState(250);
  const [message, setMessage] = React.useState('');
  const [messageSending, setMessageSending] = React.useState(false);

  const gpState = React.useRef({...initialGamepadState}).current;
  const webviewRef = React.useRef(null);
  const gamepadReady = React.useRef(false);
  const publishGamepad = React.useRef(null);
  const syncGamepad = React.useRef(null);
  const warnedAboutController = React.useRef(false);
  const liveSettings = React.useRef(null);

  React.useEffect(() => {
    if (connectState !== CONNECTED || hasController || showVirtualGamepad) {
      setShowTipsModal(false);
    } else if (hasController === false && !warnedAboutController.current) {
      warnedAboutController.current = true;
      setShowTipsModal(true);
    }
  }, [connectState, hasController, showVirtualGamepad]);

  React.useEffect(() => {
    const _settings = getSettings();
    setSettings(_settings);
    liveSettings.current = _settings;
    const settingsListener = DeviceEventEmitter.addListener(
      SETTINGS_CHANGED_EVENT,
      changed => {
        const previous = liveSettings.current;
        liveSettings.current = changed;
        if (
          previous.vibration &&
          rumbleStrength(previous) > 0 &&
          (!changed.vibration || rumbleStrength(changed) === 0)
        ) {
          GamepadManager.stopBodyRumble?.();
          if (previous.vibration_mode === 'Device') {
            Vibration.cancel();
          }
        }
      },
    );

    const normaliseAxis = value => {
      if (_settings.dead_zone) {
        if (Math.abs(value) < _settings.dead_zone) {
          return 0;
        }

        value = value - Math.sign(value) * _settings.dead_zone;
        value /= 1.0 - _settings.dead_zone;

        // Joystick edge compensation
        const THRESHOLD = 0.8;
        const MAX_VALUE = 1;
        const compensation = _settings.edge_compensation / 100 || 0;
        if (Math.abs(value) > THRESHOLD) {
          if (value > 0) {
            value = Math.min(value + compensation, MAX_VALUE);
          } else {
            value = Math.max(value - compensation, -MAX_VALUE);
          }
        }
        return value;
      } else {
        return value;
      }
    };

    const output = createGamepadOutput(state => {
      if (!gamepadReady.current || !webviewRef.current) {
        return false;
      }
      postData2Webview('gamepad', state);
      return true;
    });
    const nativeGamepad = _settings.gamepad_kernal === 'Native';
    let aim = [0, 0];
    let controllerPresent = null;
    publishGamepad.current = () => {
      output.update({
        ...gpState,
        RightThumbXAxis: Math.max(
          -1,
          Math.min(1, gpState.RightThumbXAxis + aim[0]),
        ),
        RightThumbYAxis: Math.max(
          -1,
          Math.min(1, gpState.RightThumbYAxis + aim[1]),
        ),
      });
    };
    syncGamepad.current = output.sync;
    publishGamepad.current();

    let listening = true;
    const updatePresence = present => {
      if (!listening || present === controllerPresent) {
        return;
      }
      controllerPresent = present;
      setHasController(present);
      if (!present && nativeGamepad) {
        Object.assign(gpState, initialGamepadState);
        aim = [0, 0];
        publishGamepad.current();
      }
    };
    const presenceListener = eventEmitter.addListener(
      'onControllerPresence',
      updatePresence,
    );
    GamepadManager.getControllerPresence?.().then(present => {
      if (controllerPresent === null) {
        updatePresence(present);
      }
    });

    // Controller
    let controllerListener;
    if (nativeGamepad) {
      log.info('Entry native mode');
      controllerListener = eventEmitter.addListener('onController', params => {
        const {
          buttonFlags,
          leftTrigger,
          rightTrigger,
          leftStickX,
          leftStickY,
          rightStickX,
          rightStickY,
        } = params;

        updatePresence(true);
        const keys = buttonFlags ? getPressedButtons(buttonFlags) : [];
        for (const button of gamepadButtons) {
          gpState[button] = keys.includes(button) ? 1 : 0;
        }

        // Trigger
        gpState.LeftTrigger = leftTrigger;
        gpState.RightTrigger = rightTrigger;

        // Joystick
        gpState.LeftThumbXAxis = normaliseAxis(leftStickX);
        gpState.LeftThumbYAxis = normaliseAxis(-leftStickY);
        gpState.RightThumbXAxis = normaliseAxis(rightStickX);
        gpState.RightThumbYAxis = normaliseAxis(-rightStickY);
        publishGamepad.current();
      });
    }
    startGta6Triggers(
      _settings,
      nativeGamepad
        ? push => {
            if (
              controllerPresent !== false &&
              (aim[0] !== push[0] || aim[1] !== push[1])
            ) {
              aim = push;
              publishGamepad.current();
            }
          }
        : undefined,
    );

    if (route.params?.sessionId) {
      log.info('Stream screen receive sessionId:', route.params?.sessionId);
    }
    if (route.params?.streamType) {
      log.info('Stream screen receive streamType:', route.params?.streamType);
    }
    if (streamingTokens.xHomeToken) {
      const _xHomeApi = new XcloudApi(
        streamingTokens.xHomeToken.getDefaultRegion().baseUri,
        streamingTokens.xHomeToken.data.gsToken,
        'home',
        authentication,
      );
      setXHomeApi(_xHomeApi);
    }
    if (streamingTokens.xCloudToken) {
      const _xCloudApi = new XcloudApi(
        streamingTokens.xCloudToken.getDefaultRegion().baseUri,
        streamingTokens.xCloudToken.data.gsToken,
        'cloud',
        authentication,
      );
      setXCloudApi(_xCloudApi);
    }

    setTimeout(() => {
      Orientation.lockToLandscape();

      setTimeout(() => {
        const {height: dHeight} = Dimensions.get('window');
        setModalMaxHeight(dHeight - 50);
        setShowWebview(true);
        setTimeout(() => {
          webviewRef.current && webviewRef.current.requestFocus();
        }, 100);
      }, 800);
    }, 500);

    return () => {
      Orientation.unlockAllOrientations();
      listening = false;
      settingsListener.remove();
      presenceListener.remove();
      controllerListener?.remove();
      output.dispose();
      publishGamepad.current = null;
      syncGamepad.current = null;
      stopGta6Triggers();
      GamepadManager.stopBodyRumble?.();
    };
  }, [
    route.params?.sessionId,
    route.params?.streamType,
    streamingTokens,
    gpState,
    navigation,
    authentication,
  ]);

  const streamApi = route.params?.streamType === 'cloud' ? xCloudApi : xHomeApi;

  // const uri = 'file:///android_asset/stream/index.html';
  const uri = Platform.select({
    android: 'file:///android_asset/stream/index.html',
    ios: 'index.html', // iOS 会自动从 bundle 中查找
    // ios: 'http://172.25.176.27:5173/',
  });

  const handlePowerOff = async () => {
    const webApi = new WebApi(webToken);
    const powerOffRes = await webApi.powerOff(route.params?.sessionId);
    console.log('powerOff:', powerOffRes);
  };

  const handleSendMessage = async () => {
    const webApi = new WebApi(webToken);
    setMessageSending(true);
    let text = message.trim();
    if (message > 100) {
      text = text.substring(0, 100);
    }
    try {
      await webApi.sendText(route.params?.sessionId, text);
      setMessage('');
      ToastAndroid.show(t('Sended'), ToastAndroid.SHORT);
    } catch (e) {}
    setMessageSending(false);
  };

  const handleExit = () => {
    if (isExiting) {
      return;
    }
    setIsExiting(true);
    streamApi.stopStream().then(() => {
      if (needPoweroff) {
        handlePowerOff();
      }
      setTimeout(() => {
        setIsExiting(false);
        Orientation.unlockAllOrientations();
        navigation.navigate({
          name: 'Home',
          params: {needRefresh: true},
        });
      }, 500);
    });
  };

  const handleTimeoutExit = () => {
    streamApi.stopStream().then(() => {
      authentication._tokenStore &&
        authentication._tokenStore.clearTokenUpdateTime();
      setTimeout(() => {
        RNRestart.restart();
      }, 100);
    });
  };

  const handleCloseModal = () => {
    setShowModal(false);
    if (settings.gamepad_kernal === 'Web') {
      webviewRef.current && webviewRef.current.requestFocus();
    }
  };

  const postData2Webview = (type, value) => {
    webviewRef.current &&
      webviewRef.current.postMessage(JSON.stringify({type, value}));
  };

  const handleWebviewMessage = event => {
    const data = JSON.parse(event.nativeEvent.data);
    const {type, message} = data;
    if (type === 'other') {
      Alert.alert(message);
    }
    if (type === 'xcloudReady') {
      gamepadReady.current = true;
      syncGamepad.current?.();
      const _settings = getSettings();
      log.info('Get localSettings:', _settings);

      streamApi
        .startSession(route.params?.sessionId, _settings.resolution)
        .then(configuration => {
          console.log('*****startSessionEnd:', configuration);
          postData2Webview('startSessionEnd', configuration);
        })
        .catch(e => {
          if (e !== '') {
            let msg = '';
            if (typeof e === 'string') {
              if (e.includes('WaitingForServerToRegister')) {
                msg =
                  '[StartSession] Fail:' + t('WaitingForServerToRegister') + e;
              }
            } else {
              if (e.message?.indexOf('400') > -1) {
                const error = t('noAllow');
                msg = '[StartSession] Fail:' + error;
              } else {
                msg = '[StartSession] Fail:' + e;
              }
            }
            Alert.alert(t('Warning'), msg, [
              {
                text: t('Confirm'),
                style: 'default',
                onPress: () => {
                  if (isExiting) {
                    return;
                  }
                  navigation.navigate('Home');
                },
              },
            ]);
          }
        });
    }
    if (type === 'xcloudOfferReady') {
      // log.info('receive client offer:', message);
      // sendSdp
      streamApi
        .sendSDPOffer(message)
        .then(sdpResponse => {
          log.info('sdpResponse.exchangeResponse:', sdpResponse);
          const sdpDetails = JSON.parse(sdpResponse.exchangeResponse);
          postData2Webview('sendSDPOfferEnd', sdpDetails);
        })
        .catch(e => {
          Alert.alert(t('Warning'), '[sendSDPOffer] fail:' + e, [
            {
              text: t('Confirm'),
              style: 'default',
              onPress: () => {
                handleExit();
              },
            },
          ]);
        });
    }
    if (type === 'sendICEReady') {
      log.info('sendICEReady');
      // SendICE
      streamApi
        .sendICECandidates(message)
        .then(candidates => {
          log.info('Client - ICE Candidates:', JSON.stringify(candidates));
          postData2Webview('sendIceEnd', candidates);
        })
        .catch(e => {
          Alert.alert(t('Warning'), '[sendICECandidates] fail:' + e, [
            {
              text: t('Confirm'),
              style: 'default',
              onPress: () => {
                handleExit();
              },
            },
          ]);
        });
    }
    if (type === 'sendKeepalive') {
      log.info('sendKeepalive');
      streamApi
        .sendKeepalive()
        .then(result => {
          log.info('StartStream keepalive:', JSON.stringify(result));
        })
        .catch(error => {
          log.error(
            'Failed to send keepalive. Error details:\n',
            JSON.stringify(error),
          );
        });
    }
    if (type === 'streamingClosed') {
      Alert.alert(t('Warning'), 'Streaming is closed.', [
        {
          text: t('Confirm'),
          style: 'default',
          onPress: () => {
            handleExit();
          },
        },
      ]);
    }
    if (type === 'deviceVibration' || type === 'nativeVibration') {
      const {rumbleData} = message;
      gta6Rumble(rumbleData);
      const activeSettings = liveSettings.current;
      if (type === 'nativeVibration') {
        GamepadManager.rumble(
          rumbleData.duration,
          ...controllerRumble(activeSettings, rumbleData),
        );
      } else if (
        !activeSettings.vibration ||
        rumbleStrength(activeSettings) === 0 ||
        rumbleData.strongMagnitude === 0 ||
        rumbleData.weakMagnitude === 0
      ) {
        Vibration.cancel();
      } else {
        Vibration.vibrate(rumbleData.duration / 10);
      }
    }
    if (type === 'performance') {
      const oldPerf = performance;
      const perf = message;

      if (oldPerf) {
        if (
          (!perf.br || perf.br === '--') &&
          oldPerf.br &&
          oldPerf.br !== '--'
        ) {
          perf.br = oldPerf.br;
        }
        if (
          (!perf.decode || perf.decode === '--') &&
          oldPerf.decode &&
          oldPerf.decode !== '--'
        ) {
          perf.decode = oldPerf.decode;
        }
      }
      setPerformance(perf);
    }
    if (type === 'connectionstate') {
      setConnectState(message);
      if (message === CONNECTED) {
        ToastAndroid.show(t('Connected'), ToastAndroid.SHORT);
        syncGamepad.current?.();
      }
      // Alway show virtual gamepad
      if (message === CONNECTED && settings.show_virtual_gamead) {
        setShowVirtualGamepad(true);
      }

      // Alway show performance
      if (message === CONNECTED && settings.show_performance) {
        setShowPerformance(true);

        if (settings.gamepad_kernal === 'Web') {
          handleToggleWebviewPerformance();
        }
      }
    }
    if (type === 'exit') {
      handleExit();
    }
    if (type === 'timeoutExit') {
      /* Timeout, almost is connectionstate is failed,
         this situation we should refresh all tokens to make new connection.
       */
      handleTimeoutExit();
    }
  };

  const handleToggleWebviewPerformance = () => {
    if (showPerformance) {
      postData2Webview('showPerformance', {});
    } else {
      postData2Webview('hidePerformance', {});
    }
  };

  // Virtual gamepad press
  const handleButtonPressIn = name => {
    // console.log('handleButtonPressIn:', name);
    gpState[name] = 1;
    publishGamepad.current?.();
    // if (settings.vibration) {
    //   Vibration.vibrate(3);
    // }
  };

  const handleButtonPressOut = name => {
    setTimeout(() => {
      // console.log('handleButtonPressOut:', name);
      gpState[name] = 0;
      publishGamepad.current?.();
    }, 50);
  };

  // Virtual gamepad move joystick
  const handleStickMove = (id, data) => {
    // console.log('handleStickMove:', id, data);
    let leveledX = data.dist.x;
    let leveledY = data.dist.y;

    if (typeof leveledX === 'string') {
      leveledX = leveledX.toFixed(2);
    }
    if (typeof leveledY === 'string') {
      leveledX = leveledY.toFixed(2);
    }

    if (id === 'right') {
      gpState.RightThumbXAxis = Number(leveledX);
      gpState.RightThumbYAxis = Number(-leveledY);
    } else {
      gpState.LeftThumbXAxis = Number(leveledX);
      gpState.LeftThumbYAxis = Number(-leveledY);
    }
    publishGamepad.current?.();
  };

  const pressNexus = duration => {
    gpState.Nexus = 1;
    publishGamepad.current?.();
    setTimeout(() => {
      gpState.Nexus = 0;
      publishGamepad.current?.();
    }, duration);
    handleCloseModal();
  };

  const requestExit = () => {
    setShowPerformance(false);
    setShowVirtualGamepad(false);
    postData2Webview('disconnect', {});
    setShowModal(false);
  };

  const background = {
    borderless: false,
    color: 'rgba(255, 255, 255, 0.2)',
    foreground: true,
  };

  const handleDisplayOptionsChange = React.useCallback(
    options => {
      postData2Webview('refreshVideo', options);
      settings.display_options = options;
      saveSettings({...getSettings(), display_options: options});
    },
    [settings],
  );

  const renderVirtualGamepad = () => {
    if (!showVirtualGamepad) {
      return null;
    }
    const useCustomVirtualGamepad = settings.custom_virtual_gamepad !== '';
    if (useCustomVirtualGamepad) {
      return (
        <CustomVirtualGamepad
          title={settings.custom_virtual_gamepad}
          opacity={settings.virtual_gamepad_opacity}
          onPressIn={handleButtonPressIn}
          onPressOut={handleButtonPressOut}
          onStickMove={handleStickMove}
        />
      );
    } else {
      return (
        <VirtualGamepad
          opacity={settings.virtual_gamepad_opacity}
          onPressIn={handleButtonPressIn}
          onPressOut={handleButtonPressOut}
          onStickMove={handleStickMove}
        />
      );
    }
  };

  return (
    <>
      {showPerformance && settings.gamepad_kernal === 'Native' && (
        <PerfPanel performance={performance} />
      )}

      {renderVirtualGamepad()}

      <Portal>
        <Modal
          visible={showControllerTuning}
          onDismiss={() => setShowControllerTuning(false)}
          contentContainerStyle={styles.modal}>
          <Card>
            <Card.Content>
              {showControllerTuning && (
                <ControllerTuning maxHeight={modalMaxHeight - 48} />
              )}
              <Button onPress={() => setShowControllerTuning(false)}>
                {t('Done')}
              </Button>
            </Card.Content>
          </Card>
        </Modal>
      </Portal>

      <Portal>
        <Modal
          visible={showDisplayModal}
          onDismiss={() => {
            setShowDisplayModal(false);
          }}
          contentContainerStyle={styles.modal}>
          <Card>
            <Card.Content>
              <Display
                options={settings.display_options}
                onChange={handleDisplayOptionsChange}
              />
            </Card.Content>
          </Card>
        </Modal>
      </Portal>

      <Portal>
        <Modal
          visible={showTipsModal}
          onDismiss={() => setShowTipsModal(false)}
          contentContainerStyle={styles.modal}>
          <Card>
            <Card.Content>
              <Text style={{textAlign: 'center'}}>{t('stream_warn_text')}</Text>
              <Button
                style={{marginTop: 10}}
                onPress={() => setShowTipsModal(false)}>
                {t('Confirm')}
              </Button>
            </Card.Content>
          </Card>
        </Modal>
      </Portal>

      <Portal>
        <Modal
          visible={showMessageModal}
          onDismiss={() => {
            setShowMessageModal(false);
          }}
          contentContainerStyle={styles.modal}>
          <Card>
            <Card.Content>
              <TextInput
                label={t('Text')}
                value={message}
                onChangeText={text => setMessage(text)}
              />
              <Button
                mode="contained"
                loading={messageSending}
                style={{marginTop: 10}}
                onPress={handleSendMessage}>
                {t('Send')}
              </Button>
            </Card.Content>
          </Card>
        </Modal>
      </Portal>

      <Portal>
        <Modal
          visible={showModal}
          onDismiss={() => handleCloseModal()}
          contentContainerStyle={styles.modal}>
          <Card>
            <Card.Content>
              <ScrollView style={{maxHeight: modalMaxHeight}}>
                <List.Section>
                  {connectState === CONNECTED && (
                    <List.Item
                      title={t('Controller tuning')}
                      background={background}
                      onPress={() => {
                        handleCloseModal();
                        setShowControllerTuning(true);
                      }}
                    />
                  )}
                  {connectState === CONNECTED && (
                    <List.Item
                      title={t('Toggle Performance')}
                      background={background}
                      onPress={() => {
                        if (settings.gamepad_kernal === 'Web') {
                          setShowPerformance(!showPerformance);
                          setTimeout(() => {
                            handleToggleWebviewPerformance();
                            webviewRef.current &&
                              webviewRef.current.requestFocus();
                          }, 10);
                        } else {
                          setShowPerformance(!showPerformance);
                        }
                        handleCloseModal();
                      }}
                    />
                  )}

                  {connectState === CONNECTED &&
                    settings.gamepad_kernal === 'Native' && (
                      <List.Item
                        title={t('Toggle Virtual Gamepad')}
                        background={background}
                        onPress={() => {
                          setShowVirtualGamepad(!showVirtualGamepad);
                          handleCloseModal();
                        }}
                      />
                    )}

                  {connectState === CONNECTED && (
                    <List.Item
                      title={t('Press Nexus')}
                      background={background}
                      onPress={() => pressNexus(120)}
                    />
                  )}
                  {connectState === CONNECTED &&
                    route.params?.streamType !== 'cloud' && (
                      <List.Item
                        title={t('Long press Nexus')}
                        background={background}
                        onPress={() => pressNexus(1000)}
                      />
                    )}

                  {connectState === CONNECTED &&
                    route.params?.streamType !== 'cloud' && (
                      <List.Item
                        title={t('Send text')}
                        background={background}
                        onPress={() => {
                          setShowMessageModal(true);
                          handleCloseModal();
                        }}
                      />
                    )}

                  {connectState === CONNECTED &&
                    settings.power_on &&
                    route.params?.streamType !== 'cloud' && (
                      <List.Item
                        title={t('Disconnect and power off')}
                        background={background}
                        onPress={() => {
                          setNeedPoweroff(true);
                          requestExit();
                        }}
                      />
                    )}

                  <List.Item
                    title={t('Disconnect')}
                    background={background}
                    onPress={requestExit}
                  />
                  <List.Item
                    title={t('Cancel')}
                    background={background}
                    onPress={() => handleCloseModal()}
                  />
                </List.Section>
              </ScrollView>
            </Card.Content>
          </Card>
        </Modal>
      </Portal>

      <View style={styles.quickMenu}>
        <IconButton
          icon="menu"
          size={28}
          onPress={() => {
            setShowModal(true);
          }}
        />
      </View>

      <View style={{flex: 1}}>
        {showWebview && (
          <WebView
            ref={instance => {
              webviewRef.current = instance;
            }}
            source={{uri}}
            originWhitelist={['*']}
            javaScriptEnabled={true}
            cacheEnabled={false}
            setSupportMultipleWindows={false}
            mediaPlaybackRequiresUserAction={false}
            allowsFullscreenVideo={true}
            allowsInlineMediaPlayback={true}
            androidLayerType={'hardware'}
            injectedJavaScriptObject={{
              // Keep the packets available to the trigger profile when body rumble is muted.
              settings:
                Platform.OS === 'ios'
                  ? {...settings, vibration: true}
                  : settings,
              streamType: route.params?.streamType,
            }}
            onLoadStart={() => {
              gamepadReady.current = false;
            }}
            onMessage={event => {
              handleWebviewMessage(event);
            }}
            onError={syntheticEvent => {
              const {nativeEvent} = syntheticEvent;
              console.warn('WebView error: ', nativeEvent);
            }}
          />
        )}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  card: {
    width: 300,
    padding: 5,
  },
  modal: {
    // backgroundColor: 'rgba(0, 0, 0, 0.5)',
    marginLeft: '32%',
    marginRight: '32%',
  },
  backdrop: {
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  title: {
    paddingBottom: 10,
  },
  content: {
    paddingTop: 10,
  },
  quickMenu: {
    position: 'absolute',
    right: 5,
    bottom: 5,
    zIndex: 10,
  },
});

export default StreamScreen;
