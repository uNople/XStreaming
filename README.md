<p align="center">
  <a href="https://github.com/Geocld/XStreaming">
    <img src="https://raw.githubusercontent.com/Geocld/XStreaming/main/images/logo.png" width="546">
  </a>
</p>

<p align="center">
  Opensource Xbox Remote Client.
</p>

**English** | [中文](./README.zh_CN.md)

## Intro

XStreaming is an open-source mobile client for xCloud and Xbox home streaming, great inspired by [Greenlight](https://github.com/unknownskl/greenlight).

> DISCLAIMER: XStreaming is not affiliated with Microsoft, Xbox. All rights and trademarks are property of their respective owners.

## Windows/MacOS/Linux(steamOS)

If you are looking for Windows/MacOS/Linux(steamOS) Xbox streaming application, you can use [XStreaming-desktop](https://github.com/Geocld/XStreaming-desktop) or [Greenlight](https://github.com/unknownskl/greenlight).

## Features

- Stream video and audio from the Xbox One and Xbox Series S/X
- Support for 1080P resolution
- Support for virtual\OTG\bluetooth gamepad controls
- Support gamepad vibration
- Supports rumble on xCloud without any proxy in some regions.
- Friends system
- Archivements system
- IPv6

<img src="https://raw.githubusercontent.com/Geocld/XStreaming/main/images/game.jpg" width="400" />
<img src="https://github.com/Geocld/XStreaming/blob/main/images/home.jpg" width="400" /> <img src="https://raw.githubusercontent.com/Geocld/XStreaming/main/images/xcloud.jpg" width="400" /><img src="https://raw.githubusercontent.com/Geocld/XStreaming/main/images/settings.jpg" width="400" />

## Local Development

### Requirements
- [React Native](https://reactnative.dev/) >= 0.74
- [NodeJs](https://nodejs.org/) >= 20
- [Yarn](https://yarnpkg.com/) >= 1.22

### Steps to get up and running

Clone the repository:

```
git clone https://github.com/Geocld/XStreaming
cd XStreaming
```

Install dependencies:

```
yarn
```

Run development build:

```
npm run android
```

## Development document

1. [Auth](/docs/1.Auth.md)
2. [Web API](./docs/2.Web.md)
3. [Stream](./docs/3.Stream.md)

### License

XStreaming is [MIT licensed](./LICENSE).

## Building on Linux

```
./build-ios     # unsigned XStreaming-Dev .app and .ipa in artifacts/ios-linux/out
./deploy-ios    # build, then sign, install and start it on the USB-connected iPad
```

`tools/ios-linux/build.py` runs the real `pod install`, compiles with clang and links with LLD against an Apple iOS SDK. It needs a toolchain directory (LLVM tools and the SDK) named in `IOS_LINUX_TOOLCHAIN` or in `tools/ios-linux/toolchain.local`. The app icon and launch screen are plain images, since asset catalogs and storyboards need Apple's tools.

## GTA 6 adaptive triggers (DualSense)

Settings → GTA 6 adaptive triggers. GTA 6 on Xbox sends body rumble only, so `src/triggers/gta6Profile.ts` derives the triggers from it: a trigger break and a recoil kick per shot on foot, pedal resistance and impact jolts in a vehicle. The native `GamepadManager.setAdaptiveTriggers` applies them through the GameController framework, over Bluetooth or USB.
