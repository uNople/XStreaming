#!/usr/bin/env python3
"""Build the XStreaming iOS app on Linux, without Xcode.

    tools/ios-linux/build.py build     unsigned .app and .ipa
    tools/ios-linux/build.py deploy    build, sign+install with ipad-dev, launch
    tools/ios-linux/build.py clean     remove build output (add --all for caches)

How it works
  1. yarn 4.2.2 (pinned download) installs node_modules.
  2. A pinned portable Ruby runs the real CocoaPods `pod install` against a
     staging copy of ios/ (artifacts/ios-linux/pods), so the Pods project,
     xcconfigs, header trees and React Native codegen are the genuine ones.
     tools/ios-linux/shims supplies xcrun/xcodebuild stand-ins.
  3. dump_xcodeproj.rb exports targets, sources and build settings as JSON.
     This script resolves the settings the way Xcode does and writes a ninja
     file that drives Apple-flavoured clang (from the Swift toolchain) for
     every pod and for the app sources globbed from ios/XStreaming.
  4. LLD links against the iOS SDK; Metro + hermesc produce main.jsbundle;
     the .app is assembled by hand (Info.plist, resources, icons, frameworks).

Everything generated lives in artifacts/ios-linux. The compiler, linker and
iOS SDK are reused read-only from the toolchain described by TOOLCHAIN below.
"""

import argparse
import fnmatch
import hashlib
import json
import os
import plistlib
import re
import shlex
import shutil
import struct
import subprocess
import sys
import time
import urllib.request
import xml.etree.ElementTree as ElementTree
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / 'tools' / 'ios-linux'
ART = ROOT / 'artifacts' / 'ios-linux'
DOWNLOADS = ART / 'downloads'
STAGE = ART / 'pods'
STAGE_IOS = STAGE / 'ios'
PODS_ROOT = STAGE_IOS / 'Pods'
BUILD = ART / 'build'
PRODUCTS = BUILD / 'products'
OBJECTS = BUILD / 'obj'
OUT = ART / 'out'
STAMPS = ART / 'stamps'
TMP = ART / 'tmp'

CONFIGURATION = 'Release'
APP_TARGET = 'XStreaming'
PODS_AGGREGATE_TARGET = 'Pods-XStreaming'
DEFAULT_BUNDLE_ID = 'com.dev.xstreaming'
DEFAULT_DISPLAY_NAME = 'XStreaming Dev'

# Read-only toolchain directory (LLVM tools, the Apple iOS SDK): taken from
# IOS_LINUX_TOOLCHAIN, or from the one-line, git-ignored file toolchain.local
# beside this script.
def _toolchain_dir():
    configured = os.environ.get('IOS_LINUX_TOOLCHAIN')
    local = Path(__file__).resolve().with_name('toolchain.local')
    if not configured and local.is_file():
        configured = local.read_text().strip()
    if not configured:
        sys.exit('Set IOS_LINUX_TOOLCHAIN, or write the toolchain directory into ' + str(local))
    return Path(configured)


TOOLCHAIN = _toolchain_dir()
SWIFT_TOOLCHAINS = Path.home() / '.local/share/swiftly/toolchains'

# Downloads outside yarn/CocoaPods resolution. Verified before use.
PORTABLE_RUBY = {
    'name': 'portable-ruby',
    'version': '3.4.6',
    'url': 'https://github.com/Homebrew/homebrew-portable-ruby/releases/download/3.4.6/'
           'portable-ruby-3.4.6.x86_64_linux.bottle.tar.gz',
    'sha256': '40932a3950ccc8bf9d13d98e692e5518427cc66b4f9520956cec349629d25259',
}
YARN = {
    'name': 'yarn',
    'version': '4.2.2',
    'url': 'https://repo.yarnpkg.com/4.2.2/packages/yarnpkg-cli/bin/yarn.js',
    'sha256': '1aa43a5304405be7a7cb9cb5de7b97de9c4e8ddd3273e4dad00d6ae3eb39f0ef',
}

SOURCE_EXTENSIONS = {'.m', '.mm', '.c', '.cc', '.cpp', '.cxx', '.s', '.S'}
HEADER_EXTENSIONS = {'.h', '.hh', '.hpp', '.hxx', '.pch', '.inc', '.def'}
LANGUAGE_BY_EXTENSION = {
    '.c': 'c', '.m': 'objc', '.mm': 'objcxx', '.cc': 'cxx', '.cpp': 'cxx', '.cxx': 'cxx',
    '.s': 'asm', '.S': 'asm',
}
LANGUAGE_BY_X_FLAG = {
    'c': 'c', 'objective-c': 'objc', 'c++': 'cxx', 'objective-c++': 'objcxx',
    'assembler': 'asm', 'assembler-with-cpp': 'asm',
}
# Resource types that need Apple-only compilers (actool, ibtool, momc).
APPLE_COMPILED_RESOURCES = {'.xcassets', '.storyboard', '.xib', '.xcdatamodeld', '.xcdatamodel', '.metal'}


class BuildError(RuntimeError):
    pass


def log(message):
    print(f'[ios-linux] {message}', flush=True)


def run(command, *, env=None, cwd=None, log_path=None, check=True):
    """Run a command; with log_path the output goes to that file."""
    command = [str(part) for part in command]
    if log_path:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with open(log_path, 'w') as handle:
            handle.write('$ ' + shlex.join(command) + '\n')
            handle.flush()
            result = subprocess.run(command, env=env, cwd=cwd, stdout=handle, stderr=subprocess.STDOUT)
    else:
        result = subprocess.run(command, env=env, cwd=cwd)
    if check and result.returncode != 0:
        hint = f' (log: {log_path})' if log_path else ''
        if log_path:
            tail = log_path.read_text(errors='replace').splitlines()[-40:]
            print('\n'.join(tail), file=sys.stderr)
        raise BuildError(f'command failed with exit code {result.returncode}: {shlex.join(command[:6])} ...{hint}')
    return result


def capture(command, *, env=None, cwd=None):
    result = subprocess.run([str(part) for part in command], env=env, cwd=cwd, capture_output=True, text=True)
    if result.returncode != 0:
        raise BuildError(f'command failed: {shlex.join(str(p) for p in command)}\n{result.stderr.strip()}')
    return result.stdout


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for block in iter(lambda: handle.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


def fingerprint(paths, extra=()):
    """Content hash of a set of files/directories plus arbitrary strings."""
    digest = hashlib.sha256()
    for item in extra:
        digest.update(repr(item).encode())
    for path in sorted(str(p) for p in paths):
        path = Path(path)
        if path.is_dir():
            for child in sorted(p for p in path.rglob('*') if p.is_file()):
                digest.update(str(child).encode())
                digest.update(sha256_file(child).encode())
        elif path.exists():
            digest.update(str(path).encode())
            digest.update(sha256_file(path).encode())
        else:
            digest.update(f'missing:{path}'.encode())
    return digest.hexdigest()


def stat_fingerprint(paths, extra=()):
    """Cheap hash (path, size, mtime) for large trees such as the JS sources."""
    digest = hashlib.sha256()
    for item in extra:
        digest.update(repr(item).encode())
    for path in sorted(str(p) for p in paths):
        path = Path(path)
        files = sorted(p for p in path.rglob('*') if p.is_file()) if path.is_dir() else [path]
        for child in files:
            try:
                info = child.stat()
            except FileNotFoundError:
                digest.update(f'missing:{child}'.encode())
                continue
            digest.update(f'{child}:{info.st_size}:{info.st_mtime_ns}'.encode())
    return digest.hexdigest()


def stamp_matches(name, value):
    path = STAMPS / name
    return path.exists() and path.read_text().strip() == value


def write_stamp(name, value):
    STAMPS.mkdir(parents=True, exist_ok=True)
    (STAMPS / name).write_text(value + '\n')


def write_if_changed(path, data):
    """Write bytes/str only when the content differs (keeps mtimes stable for ninja)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = data.encode() if isinstance(data, str) else data
    if path.exists() and path.read_bytes() == payload:
        return False
    path.write_bytes(payload)
    return True


# --------------------------------------------------------------------------
# Toolchain discovery
# --------------------------------------------------------------------------

class Toolchain:
    def __init__(self):
        self.clang = self._find_clang()
        self.clangxx = Path(str(self.clang) + '++')
        self.llvm_ar = self.clang.parent / 'llvm-ar'
        self.lld = self._find_llvm_tool('ld64.lld', 'IOS_LINUX_LLD')
        self.dsymutil = self._find_llvm_tool('dsymutil', 'IOS_LINUX_DSYMUTIL')
        platform = TOOLCHAIN / 'sdk/xcross-darwin.artifactbundle/Developer/Platforms/iPhoneOS.platform'
        sdks = sorted((platform / 'Developer/SDKs').glob('iPhoneOS[0-9]*.sdk'))
        if not sdks:
            raise BuildError(f'no iPhoneOS SDK under {platform}')
        self.sdk = sdks[-1]
        settings = json.loads((self.sdk / 'SDKSettings.json').read_text())
        self.sdk_version = settings['Version']
        self.sdk_name = settings['CanonicalName']
        runtime = TOOLCHAIN / 'sdk/xcross-darwin.artifactbundle/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/clang'
        candidates = sorted(runtime.glob('*/lib/darwin/libclang_rt.ios.a'))
        if not candidates:
            raise BuildError(f'libclang_rt.ios.a not found under {runtime}')
        self.clang_rt = candidates[-1]
        self.node = Path(shutil.which('node') or '')
        self.ninja = Path(shutil.which('ninja') or '')
        for label, path in (('clang', self.clang), ('clang++', self.clangxx), ('llvm-ar', self.llvm_ar),
                            ('ld64.lld', self.lld), ('node', self.node), ('ninja', self.ninja)):
            if not path or not Path(path).is_file():
                raise BuildError(f'required tool missing: {label} ({path})')

    @staticmethod
    def _find_clang():
        override = os.environ.get('IOS_LINUX_CLANG')
        if override:
            return Path(override)
        # The Swift toolchain's clang is Apple's fork; it understands the SDK's
        # module maps, which the distribution clang does not.
        candidates = sorted(SWIFT_TOOLCHAINS.glob('*/usr/bin/clang'))
        if not candidates:
            raise BuildError(f'no Swift toolchain clang under {SWIFT_TOOLCHAINS}')
        return candidates[-1]

    @staticmethod
    def _find_llvm_tool(name, variable):
        override = os.environ.get(variable)
        if override:
            return Path(override)
        # The Swift toolchain's ld64.lld refuses iOS and it has no dsymutil;
        # the distribution's LLVM builds provide both.
        for version in (20, 21, 19, 22):
            candidate = Path(f'/usr/lib/llvm-{version}/bin/{name}')
            if candidate.is_file():
                return candidate
        raise BuildError(f'no /usr/lib/llvm-*/bin/{name} found')

    def version_of(self, tool, flag='--version'):
        try:
            return capture([tool, flag]).splitlines()[0].strip()
        except (BuildError, IndexError, OSError):
            return 'unknown'


def base_env(toolchain, deployment_target='16.6', apple_shims=False):
    """Environment for yarn, bundler, CocoaPods, Metro and script phases. Caches
    stay in artifacts. The xcrun/xcodebuild/dsymutil stand-ins are only put on
    PATH for the steps that expect Apple tools (pod install, script phases), so
    host builds such as gem native extensions never see them."""
    ruby_bin = ART / 'ruby' / 'portable-ruby' / PORTABLE_RUBY['version'] / 'bin'
    env = dict(os.environ)
    search = [str(ruby_bin), str(toolchain.node.parent), env.get('PATH', '')]
    if apple_shims:
        search.insert(0, str(TOOLS / 'shims'))
    env.update({
        'PATH': os.pathsep.join(search),
        'TMPDIR': str(TMP),
        'LANG': 'C.UTF-8',
        'LC_ALL': 'C.UTF-8',
        # yarn
        'YARN_GLOBAL_FOLDER': str(ART / 'yarn-global'),
        'YARN_ENABLE_GLOBAL_CACHE': 'true',
        'YARN_INSTALL_STATE_PATH': str(ART / 'yarn-install-state.gz'),
        'YARN_ENABLE_TELEMETRY': '0',
        'YARN_IGNORE_PATH': '1',
        'COREPACK_ENABLE_STRICT': '0',
        # bundler / rubygems
        'BUNDLE_GEMFILE': str(TOOLS / 'Gemfile'),
        'BUNDLE_PATH': str(ART / 'gems'),
        'BUNDLE_APP_CONFIG': str(ART / 'bundle-config'),
        'BUNDLE_USER_HOME': str(ART / 'bundle-home'),
        'BUNDLE_FROZEN': 'true',
        'BUNDLE_JOBS': '8',
        'GEM_HOME': str(ART / 'gem-home'),
        'GEM_SPEC_CACHE': str(ART / 'gem-spec-cache'),
        # CocoaPods
        'CP_HOME_DIR': str(ART / 'cocoapods-home'),
        'CP_CACHE_DIR': str(ART / 'cocoapods-cache'),
        'COCOAPODS_DISABLE_STATS': '1',
        # Release flavour of the prebuilt Hermes engine (see hermes-engine.podspec).
        'PRODUCTION': '1',
        # shims
        'IOS_LINUX_SDK': str(toolchain.sdk),
        'IOS_LINUX_SDK_VERSION': toolchain.sdk_version,
        'IOS_LINUX_CLANG': str(toolchain.clang),
        'IOS_LINUX_LLD': str(toolchain.lld),
        'IOS_LINUX_DSYMUTIL': str(toolchain.dsymutil),
        'IOS_LINUX_DEPLOYMENT_TARGET': deployment_target,
        'IOS_LINUX_XCODE_VERSION': toolchain.sdk_version,
    })
    for noisy in ('GEM_PATH', 'RUBYOPT', 'RUBYLIB', 'BUNDLE_BIN_PATH'):
        env.pop(noisy, None)
    return env


# --------------------------------------------------------------------------
# Stage: pinned downloads, Ruby, gems, yarn
# --------------------------------------------------------------------------

def fetch_pinned(spec, destination):
    if destination.exists() and sha256_file(destination) == spec['sha256']:
        return destination
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_suffix(destination.suffix + '.part')
    log(f"downloading {spec['name']} {spec['version']}")
    request = urllib.request.Request(spec['url'], headers={'User-Agent': 'ios-linux-build'})
    with urllib.request.urlopen(request) as response, open(partial, 'wb') as handle:
        shutil.copyfileobj(response, handle)
    actual = sha256_file(partial)
    if actual != spec['sha256']:
        partial.unlink()
        raise BuildError(f"{spec['name']} checksum mismatch: expected {spec['sha256']}, got {actual}")
    partial.rename(destination)
    return destination


def stage_ruby(env):
    archive = fetch_pinned(PORTABLE_RUBY, DOWNLOADS / Path(PORTABLE_RUBY['url']).name)
    ruby = ART / 'ruby' / 'portable-ruby' / PORTABLE_RUBY['version'] / 'bin' / 'ruby'
    if not ruby.exists():
        log('unpacking portable Ruby')
        shutil.rmtree(ART / 'ruby', ignore_errors=True)
        (ART / 'ruby').mkdir(parents=True)
        run(['tar', '-xzf', archive, '-C', ART / 'ruby'])
    stamp = fingerprint([TOOLS / 'Gemfile', TOOLS / 'Gemfile.lock'], extra=[PORTABLE_RUBY['sha256']])
    if not stamp_matches('gems', stamp):
        log('installing CocoaPods gems (bundler, frozen lockfile with checksums)')
        run(['bundle', 'install'], env=env, cwd=TOOLS, log_path=ART / 'logs' / 'bundle-install.log')
        write_stamp('gems', stamp)


def stage_yarn(env, toolchain):
    yarn_js = fetch_pinned(YARN, DOWNLOADS / f"yarn-{YARN['version']}.cjs")
    package = json.loads((ROOT / 'package.json').read_text())
    declared = package.get('packageManager', '')
    if declared and declared.split('+')[0] != f"yarn@{YARN['version']}":
        raise BuildError(f"package.json wants {declared}; tools/ios-linux pins yarn@{YARN['version']}")
    stamp = fingerprint([ROOT / 'package.json', ROOT / 'yarn.lock', ROOT / '.yarnrc.yml', ROOT / 'patches'],
                        extra=[YARN['sha256']])
    if stamp_matches('yarn', stamp) and (ROOT / 'node_modules' / '.yarn-state.yml').exists():
        return
    log('yarn install --immutable')
    run([toolchain.node, yarn_js, 'install', '--immutable'], env=env, cwd=ROOT,
        log_path=ART / 'logs' / 'yarn-install.log')
    write_stamp('yarn', stamp)


# --------------------------------------------------------------------------
# Stage: CocoaPods in a staging copy of ios/
# --------------------------------------------------------------------------

def relative_symlink(link, target):
    link.parent.mkdir(parents=True, exist_ok=True)
    desired = os.path.relpath(target, link.parent)
    if link.is_symlink():
        if os.readlink(link) == desired:
            return
        link.unlink()
    elif link.exists():
        raise BuildError(f'{link} exists and is not a symlink')
    link.symlink_to(desired)


def apply_folly_time_workaround():
    """React Native's post-install hook edits RCT-Folly's Time.h through
    `sed -i -e $'s/...//'`. On Linux /bin/sh is dash, where $'..' is not a
    quoting form, so the edit silently does nothing. Apply the same edit."""
    header = PODS_ROOT / 'RCT-Folly/folly/portability/Time.h'
    if not header.exists():
        return
    needle = ' && (__IPHONE_OS_VERSION_MIN_REQUIRED < __IPHONE_10_0)'
    lines = header.read_text().split('\n')
    changed = [line.replace(needle, '', 1) for line in lines]
    if changed != lines:
        # Pod sources are read-only; replace the file the way `sed -i` would.
        replacement = header.with_name(header.name + '.ios-linux')
        replacement.write_text('\n'.join(changed))
        os.replace(replacement, header)


def stage_pods(env):
    inputs = [ROOT / 'ios/Podfile', ROOT / 'ios/Podfile.lock', ROOT / 'ios/XStreaming.xcodeproj/project.pbxproj',
              ROOT / 'yarn.lock', ROOT / 'package.json', TOOLS / 'shims', TOOLS / 'Gemfile.lock']
    stamp = fingerprint(inputs, extra=['pods-stage-v3', env['IOS_LINUX_SDK'], env['IOS_LINUX_CLANG'], env['PRODUCTION']])
    if stamp_matches('pods', stamp) and (PODS_ROOT / 'Manifest.lock').exists():
        return False
    log('pod install (staging copy in artifacts/ios-linux/pods)')
    STAGE_IOS.mkdir(parents=True, exist_ok=True)
    relative_symlink(STAGE / 'node_modules', ROOT / 'node_modules')
    relative_symlink(STAGE / 'package.json', ROOT / 'package.json')
    shutil.copy2(ROOT / 'ios/Podfile', STAGE_IOS / 'Podfile')
    shutil.copy2(ROOT / 'ios/Podfile.lock', STAGE_IOS / 'Podfile.lock')
    staged_project = STAGE_IOS / 'XStreaming.xcodeproj'
    shutil.rmtree(staged_project, ignore_errors=True)
    shutil.copytree(ROOT / 'ios/XStreaming.xcodeproj', staged_project,
                    ignore=shutil.ignore_patterns('xcuserdata', '*.xcuserstate'))
    run(['bundle', 'exec', 'pod', 'install'], env=env, cwd=STAGE_IOS, log_path=ART / 'logs' / 'pod-install.log')
    apply_folly_time_workaround()
    # pod install resets generated sources; make every script phase run again.
    for stale in STAMPS.glob('script-*'):
        stale.unlink()
    write_stamp('pods', stamp)
    return True


def dump_projects(env, force):
    pods_json = BUILD / 'pods-project.json'
    app_json = BUILD / 'app-project.json'
    script = TOOLS / 'dump_xcodeproj.rb'
    BUILD.mkdir(parents=True, exist_ok=True)
    stamp = fingerprint([script, PODS_ROOT / 'Manifest.lock', STAGE_IOS / 'XStreaming.xcodeproj/project.pbxproj'])
    if force or not (pods_json.exists() and app_json.exists() and stamp_matches('dump', stamp)):
        run(['bundle', 'exec', 'ruby', script, PODS_ROOT / 'Pods.xcodeproj', CONFIGURATION, pods_json], env=env, cwd=TOOLS)
        run(['bundle', 'exec', 'ruby', script, STAGE_IOS / 'XStreaming.xcodeproj', CONFIGURATION, app_json], env=env, cwd=TOOLS)
        write_stamp('dump', stamp)
    return json.loads(pods_json.read_text()), json.loads(app_json.read_text())


# --------------------------------------------------------------------------
# Xcode build setting resolution
# --------------------------------------------------------------------------

REFERENCE = re.compile(r'\$(?:\(([A-Za-z0-9_]+)((?::[^()${}]*)?)\)|\{([A-Za-z0-9_]+)((?::[^()${}]*)?)\})')
CONDITIONAL_KEY = re.compile(r'^([A-Za-z0-9_]+)((?:\[[^\]]+\])+)$')


def flatten_value(value):
    if isinstance(value, list):
        parts = []
        for item in value:
            item = str(item)
            if not item.strip():
                continue
            if re.search(r'\s', item) and '$(inherited)' not in item and not (item.startswith('"') and item.endswith('"')):
                item = '"' + item.replace('\\', '\\\\').replace('"', '\\"') + '"'
            parts.append(item)
        return ' '.join(parts)
    return '' if value is None else str(value)


class Settings:
    """Layered build settings: later layers override earlier ones, $(inherited)
    reaches into the layer below, other references resolve from the top."""

    CONDITIONS = {'sdk': 'iphoneos', 'arch': 'arm64', 'config': CONFIGURATION, 'variant': 'normal'}

    def __init__(self, layers):
        self.layers = [self._normalise(layer) for layer in layers]

    @classmethod
    def _normalise(cls, layer):
        plain, conditional = {}, {}
        for key, value in layer.items():
            match = CONDITIONAL_KEY.match(key)
            if not match:
                plain[key] = flatten_value(value)
                continue
            applies = True
            for condition in re.findall(r'\[([^\]]+)\]', match.group(2)):
                for clause in condition.split(','):
                    name, _, pattern = clause.partition('=')
                    actual = cls.CONDITIONS.get(name.strip())
                    if actual is None:
                        applies = False
                    elif name.strip() == 'sdk':
                        applies = applies and (fnmatch.fnmatch(actual, pattern) or fnmatch.fnmatch(actual + '99.0', pattern))
                    else:
                        applies = applies and fnmatch.fnmatch(actual, pattern)
            if applies:
                conditional[match.group(1)] = flatten_value(value)
        plain.update(conditional)
        return plain

    def keys(self):
        seen = set()
        for layer in self.layers:
            seen.update(layer)
        return seen

    def get(self, key, default=''):
        value = self._lookup(key, len(self.layers) - 1, ())
        return default if value is None else value

    def get_list(self, key):
        value = self.get(key)
        try:
            return shlex.split(value)
        except ValueError:
            return value.split()

    def is_yes(self, key, default=False):
        value = self.get(key, None)
        if value is None or value == '':
            return default
        return value.strip().upper().startswith('YES')

    def expand(self, text):
        return self._expand(text, None, len(self.layers) - 1, ())

    def _lookup(self, key, level, stack):
        while level >= 0 and key not in self.layers[level]:
            level -= 1
        if level < 0:
            return None
        if (key, level) in stack:
            return ''
        return self._expand(self.layers[level][key], key, level, stack + ((key, level),))

    def _expand(self, text, own_key, level, stack):
        def resolve(match):
            name = match.group(1) or match.group(3)
            modifier = (match.group(2) or match.group(4) or '')[1:]
            if name == 'inherited':
                value = self._lookup(own_key, level - 1, stack) if own_key else ''
            else:
                value = self._lookup(name, len(self.layers) - 1, stack)
            return self._modify(value or '', modifier)

        # Looked-up values come back fully expanded; extra passes only serve
        # nested forms such as $(FOO_$(BAR)).
        for _ in range(10):
            if '$' not in text:
                break
            expanded = REFERENCE.sub(resolve, text)
            if expanded == text:
                break
            text = expanded
        return text

    @staticmethod
    def _modify(value, modifier):
        for operation in filter(None, modifier.split(':')):
            if operation in ('rfc1034identifier',):
                value = re.sub(r'[^A-Za-z0-9.-]', '-', value)
            elif operation in ('c99extidentifier', 'identifier'):
                value = re.sub(r'[^A-Za-z0-9_]', '_', value)
            elif operation == 'lower':
                value = value.lower()
            elif operation == 'upper':
                value = value.upper()
            elif operation == 'dir':
                value = os.path.dirname(value)
            elif operation == 'file':
                value = os.path.basename(value)
            elif operation == 'base':
                value = os.path.splitext(os.path.basename(value))[0]
            elif operation == 'standardizepath':
                value = os.path.normpath(value) if value else value
            elif operation.startswith('default='):
                value = value or operation[len('default='):]
        return value


def builtin_settings(toolchain, target_name, project_dir):
    return {
        'SRCROOT': str(project_dir),
        'PROJECT_DIR': str(project_dir),
        'SOURCE_ROOT': str(project_dir),
        'BUILD_DIR': str(PRODUCTS),
        'BUILD_ROOT': str(PRODUCTS),
        'SYMROOT': str(PRODUCTS),
        'OBJROOT': str(BUILD / 'intermediates'),
        'CONFIGURATION': CONFIGURATION,
        'PLATFORM_NAME': 'iphoneos',
        'EFFECTIVE_PLATFORM_NAME': '-iphoneos',
        'SDK_NAME': toolchain.sdk_name,
        'SDK_VERSION': toolchain.sdk_version,
        'ARCHS': 'arm64',
        'CURRENT_ARCH': 'arm64',
        'NATIVE_ARCH': 'arm64',
        'TARGET_NAME': target_name,
        'TARGETNAME': target_name,
        'PRODUCT_NAME': '$(TARGET_NAME)',
        'PRODUCT_MODULE_NAME': '$(PRODUCT_NAME:c99extidentifier)',
        'EXECUTABLE_NAME': '$(EXECUTABLE_PREFIX)$(PRODUCT_NAME)$(EXECUTABLE_SUFFIX)',
        'DEVELOPMENT_LANGUAGE': 'en',
        'CONFIGURATION_BUILD_DIR': '$(BUILD_DIR)/$(CONFIGURATION)$(EFFECTIVE_PLATFORM_NAME)',
        'BUILT_PRODUCTS_DIR': '$(CONFIGURATION_BUILD_DIR)',
        'TARGET_BUILD_DIR': '$(CONFIGURATION_BUILD_DIR)',
        'CONFIGURATION_TEMP_DIR': '$(OBJROOT)/$(CONFIGURATION)$(EFFECTIVE_PLATFORM_NAME)',
        'TARGET_TEMP_DIR': '$(CONFIGURATION_TEMP_DIR)/$(TARGET_NAME).build',
        'DERIVED_FILE_DIR': '$(TARGET_TEMP_DIR)/DerivedSources',
        'DERIVED_SOURCES_DIR': '$(DERIVED_FILE_DIR)',
        'WRAPPER_NAME': '$(PRODUCT_NAME).$(WRAPPER_EXTENSION)',
        'WRAPPER_EXTENSION': 'app',
        'FRAMEWORKS_FOLDER_PATH': '$(WRAPPER_NAME)/Frameworks',
        'UNLOCALIZED_RESOURCES_FOLDER_PATH': '$(WRAPPER_NAME)',
        'EXECUTABLE_FOLDER_PATH': '$(WRAPPER_NAME)',
        'GCC_OPTIMIZATION_LEVEL': 's',
        'USE_HEADERMAP': 'YES',
        'CLANG_ENABLE_MODULES': 'NO',
        'CLANG_ENABLE_OBJC_ARC': 'NO',
        'CLANG_ENABLE_OBJC_WEAK': 'NO',
        'DEAD_CODE_STRIPPING': 'YES',
        'HOME': str(Path.home()),
    }


def forced_settings(toolchain):
    return {
        'SDKROOT': str(toolchain.sdk),
        'SDK_DIR': str(toolchain.sdk),
        'PODS_BUILD_DIR': str(PRODUCTS),
    }


def target_settings(toolchain, project, target, project_dir, extra_forced=None):
    forced = forced_settings(toolchain)
    forced.update(extra_forced or {})
    return Settings([
        builtin_settings(toolchain, target['name'], project_dir),
        project['project_config']['settings'],
        project['project_config']['xcconfig'],
        target['config']['xcconfig'],
        target['config']['settings'],
        forced,
    ])


# --------------------------------------------------------------------------
# Header maps (the binary .hmap format clang reads natively)
# --------------------------------------------------------------------------

def write_header_map(path, mapping):
    def hmap_hash(key):
        return sum(ord(char.lower()) * 13 for char in key)

    bucket_count = 1
    while bucket_count < max(1, len(mapping) * 3):
        bucket_count *= 2
    table = [(0, 0, 0)] * bucket_count
    strings = bytearray(b'\0')
    max_value_length = 0
    for key, value in sorted(mapping.items()):
        value = str(value)
        max_value_length = max(max_value_length, len(value))
        key_index = len(strings)
        strings += key.encode() + b'\0'
        prefix_index = len(strings)
        strings += (os.path.dirname(value) + '/').encode() + b'\0'
        suffix_index = len(strings)
        strings += os.path.basename(value).encode() + b'\0'
        start = hmap_hash(key)
        for offset in range(bucket_count):
            slot = (start + offset) % bucket_count
            if table[slot][0] == 0:
                table[slot] = (key_index, prefix_index, suffix_index)
                break
    header_format = '<HHIIII'
    strings_offset = 4 + struct.calcsize(header_format) + bucket_count * 12
    blob = bytearray(b'pamh')
    blob += struct.pack(header_format, 1, 0, strings_offset, len(mapping), bucket_count, max_value_length)
    for bucket in table:
        blob += struct.pack('<III', *bucket)
    blob += strings
    write_if_changed(path, bytes(blob))


_CASE_MAPS = {}


def case_insensitive_map(directory):
    """macOS file systems ignore case, and a few pods rely on it (for example
    `#import <react/RCTAssert.h>` for React/RCTAssert.h). Header-map lookups
    are case-insensitive, so a map of a search directory's own files, searched
    right after that directory, restores the macOS behaviour on Linux."""
    if directory in _CASE_MAPS:
        return _CASE_MAPS[directory]
    mapping = {}
    for current, _dirs, files in os.walk(directory, followlinks=True):
        relative = os.path.relpath(current, directory)
        for name in files:
            suffix = os.path.splitext(name)[1].lower()
            if suffix in SOURCE_EXTENSIONS or suffix in {'.o', '.a', '.md', '.txt', '.json', '.js', '.rb', '.podspec'}:
                continue
            key = name if relative == '.' else f'{relative}/{name}'
            mapping[key] = os.path.join(current, name)
        if len(mapping) > 60000:
            mapping = None
            break
    result = None
    if mapping:
        result = BUILD / 'hmap' / 'case' / (hashlib.sha1(directory.encode()).hexdigest()[:16] + '.hmap')
        write_header_map(result, mapping)
    _CASE_MAPS[directory] = result
    return result


# --------------------------------------------------------------------------
# Compile graph
# --------------------------------------------------------------------------

def rsp_quote(argument):
    if argument and not re.search(r'[\s"\'\\#]', argument):
        return argument
    return '"' + argument.replace('\\', '\\\\').replace('"', '\\"') + '"'


def ninja_escape(text):
    return text.replace('$', '$$').replace('\n', ' ')


def ninja_path(path):
    return str(path).replace('$', '$$').replace(' ', '$ ').replace(':', '$:')


def expand_search_paths(paths):
    result = []
    for entry in paths:
        recursive = entry.endswith('/**')
        base = Path(entry[:-3] if recursive else entry)
        if not base.is_dir():
            # Build-product directories appear during the build; keep them so
            # the flags of a first build and of a rebuild are identical.
            if str(base).startswith(str(PRODUCTS)):
                result.append(str(base))
            continue
        result.append(str(base))
        if recursive:
            result.extend(str(p) for p in sorted(base.rglob('*')) if p.is_dir())
    seen, unique = set(), []
    for entry in result:
        if entry not in seen:
            seen.add(entry)
            unique.append(entry)
    return unique


def language_standard_flags(settings, language):
    flags = []
    if language in ('c', 'objc'):
        standard = settings.get('GCC_C_LANGUAGE_STANDARD')
        if standard and standard != 'compiler-default':
            flags.append(f'-std={standard}')
    elif language in ('cxx', 'objcxx'):
        standard = settings.get('CLANG_CXX_LANGUAGE_STANDARD')
        if standard and standard != 'compiler-default':
            flags.append(f'-std={standard}')
        library = settings.get('CLANG_CXX_LIBRARY')
        if library and library != 'compiler-default':
            flags.append(f'-stdlib={library}')
    return flags


class CompileUnit:
    """One target's compile configuration: flags per language plus its sources."""

    def __init__(self, toolchain, name, settings, sources, headers, quiet, project_hmap, optimization):
        self.toolchain = toolchain
        self.name = name
        self.settings = settings
        self.sources = sources          # [(Path, [per-file flags])]
        self.headers = headers          # [Path]
        self.quiet = quiet
        self.project_hmap = project_hmap
        self.optimization = optimization
        self.dir = OBJECTS / re.sub(r'[^A-Za-z0-9._-]', '_', name)
        self.deployment_target = settings.get('IPHONEOS_DEPLOYMENT_TARGET') or '12.4'

    def language_flags(self, language):
        settings = self.settings
        flags = ['-target', f'arm64-apple-ios{self.deployment_target}', '-isysroot', str(self.toolchain.sdk)]
        if language == 'asm':
            flags += self._preprocessor_flags()
            return flags
        flags += language_standard_flags(settings, language)
        level = self.optimization or settings.get('GCC_OPTIMIZATION_LEVEL') or 's'
        flags.append(f'-O{level}')
        flags += ['-fmessage-length=0', '-fpascal-strings', '-fstrict-aliasing', '-fdiagnostics-color=always']
        if settings.is_yes('GCC_NO_COMMON_BLOCKS'):
            flags.append('-fno-common')
        if settings.is_yes('GCC_SYMBOLS_PRIVATE_EXTERN'):
            flags.append('-fvisibility=hidden')
        if settings.is_yes('GCC_INLINES_ARE_PRIVATE_EXTERN') and language in ('cxx', 'objcxx'):
            flags.append('-fvisibility-inlines-hidden')
        if settings.get('GCC_ENABLE_CPP_EXCEPTIONS') == 'NO' and language in ('cxx', 'objcxx'):
            flags.append('-fno-exceptions')
        if settings.get('GCC_ENABLE_CPP_RTTI') == 'NO' and language in ('cxx', 'objcxx'):
            flags.append('-fno-rtti')
        if language in ('objc', 'objcxx'):
            if settings.is_yes('CLANG_ENABLE_OBJC_ARC'):
                flags.append('-fobjc-arc')
            if settings.is_yes('CLANG_ENABLE_OBJC_WEAK'):
                flags.append('-fobjc-weak')
        # Xcode enables clang modules for C and Objective-C only.
        if language in ('c', 'objc') and settings.is_yes('CLANG_ENABLE_MODULES'):
            flags += ['-fmodules', f'-fmodules-cache-path={BUILD / "module-cache"}']
            if settings.is_yes('DEFINES_MODULE') and settings.get('PRODUCT_MODULE_NAME'):
                flags.append(f"-fmodule-name={settings.get('PRODUCT_MODULE_NAME')}")
        flags += self._preprocessor_flags()
        other = settings.get_list('OTHER_CFLAGS')
        if language in ('cxx', 'objcxx') and 'OTHER_CPLUSPLUSFLAGS' in settings.keys():
            other = settings.get_list('OTHER_CPLUSPLUSFLAGS')
        flags += other
        prefix = settings.get('GCC_PREFIX_HEADER')
        if prefix:
            prefix_path = Path(prefix) if os.path.isabs(prefix) else Path(settings.get('SRCROOT')) / prefix
            if prefix_path.exists():
                flags += ['-include', str(prefix_path)]
        return flags

    def _preprocessor_flags(self):
        settings = self.settings
        flags = []
        for definition in settings.get_list('GCC_PREPROCESSOR_DEFINITIONS'):
            flags.append(f'-D{definition}')
        if settings.get('ENABLE_NS_ASSERTIONS') == 'NO':
            flags.append('-DNS_BLOCK_ASSERTIONS=1')
        if settings.is_yes('ENABLE_STRICT_OBJC_MSGSEND'):
            flags.append('-DOBJC_OLD_DISPATCH_PROTOTYPES=0')
        if settings.is_yes('USE_HEADERMAP', default=True):
            own = {header.name: header for header in self.headers}
            if own:
                own_map = self.dir / 'own-target-headers.hmap'
                write_header_map(own_map, own)
                flags += ['-I', str(own_map)]
            if self.project_hmap:
                flags += ['-iquote', str(self.project_hmap)]
        for path in expand_search_paths(settings.get_list('USER_HEADER_SEARCH_PATHS')):
            flags += ['-iquote', path]
        for path in expand_search_paths(settings.get_list('HEADER_SEARCH_PATHS')):
            flags += ['-I', path]
            fallback = case_insensitive_map(path)
            if fallback:
                flags += ['-I', str(fallback)]
        for path in expand_search_paths(settings.get_list('SYSTEM_HEADER_SEARCH_PATHS')):
            flags += ['-isystem', path]
        for path in expand_search_paths(settings.get_list('FRAMEWORK_SEARCH_PATHS')):
            flags += ['-F', path]
        return flags

    def emit(self, lines):
        """Write per-language response files and ninja edges; return object paths."""
        self.dir.mkdir(parents=True, exist_ok=True)
        excluded = self.settings.get_list('EXCLUDED_SOURCE_FILE_NAMES')
        included = self.settings.get_list('INCLUDED_SOURCE_FILE_NAMES')
        response_files = {}
        objects = []
        used_names = set()
        for source, file_flags in self.sources:
            if any(fnmatch.fnmatch(source.name, p) or fnmatch.fnmatch(str(source), p) for p in excluded) and \
                    not any(fnmatch.fnmatch(source.name, p) or fnmatch.fnmatch(str(source), p) for p in included):
                continue
            language = LANGUAGE_BY_EXTENSION.get(source.suffix if source.suffix == '.S' else source.suffix.lower())
            for index, flag in enumerate(file_flags):
                if flag == '-x' and index + 1 < len(file_flags):
                    language = LANGUAGE_BY_X_FLAG.get(file_flags[index + 1], language)
            if language is None:
                raise BuildError(f'{self.name}: do not know how to compile {source}')
            if language not in response_files:
                response = self.dir / f'flags-{language}.rsp'
                write_if_changed(response, '\n'.join(rsp_quote(flag) for flag in self.language_flags(language)) + '\n')
                response_files[language] = response
            digest = hashlib.sha1(str(source).encode()).hexdigest()[:8]
            object_path = self.dir / f'{source.stem}-{digest}.o'
            if object_path in used_names:
                raise BuildError(f'{self.name}: duplicate source {source}')
            used_names.add(object_path)
            compiler = self.toolchain.clangxx if language in ('cxx', 'objcxx') else self.toolchain.clang
            extra = list(file_flags)
            if self.quiet:
                extra.append('-w')
            lines.append(f'build {ninja_path(object_path)}: compile {ninja_path(source)} | {ninja_path(response_files[language])}')
            lines.append(f'  compiler = {ninja_escape(shlex.quote(str(compiler)))}')
            lines.append(f'  rsp = {ninja_escape(shlex.quote(str(response_files[language])))}')
            lines.append(f'  fileflags = {ninja_escape(shlex.join(extra))}')
            lines.append(f'  label = {ninja_escape(self.name)}')
            objects.append(object_path)
        return objects


def collect_pod_targets(pods_project):
    targets = {target['name']: target for target in pods_project['targets']}
    if PODS_AGGREGATE_TARGET not in targets:
        raise BuildError(f'{PODS_AGGREGATE_TARGET} not found in Pods project')
    ordered, seen = [], set()

    def visit(name):
        if name in seen or name not in targets:
            return
        seen.add(name)
        for dependency in targets[name]['dependencies']:
            visit(dependency)
        ordered.append(targets[name])

    visit(PODS_AGGREGATE_TARGET)
    return ordered


def split_flags(settings, text):
    if not text:
        return []
    expanded = settings.expand(text.replace('$(inherited)', ''))
    try:
        return shlex.split(expanded)
    except ValueError:
        return expanded.split()


def app_sources_and_headers(group_dirs, exceptions):
    sources, headers = [], []
    for group in group_dirs:
        for path in sorted(group.rglob('*')):
            if not path.is_file() or path.name in exceptions:
                continue
            relative = path.relative_to(group).as_posix()
            if relative in exceptions:
                continue
            if any(part.endswith('.xcassets') or part.endswith('.bundle') or part.endswith('.framework')
                   for part in path.relative_to(group).parts[:-1]):
                continue
            suffix = path.suffix if path.suffix == '.S' else path.suffix.lower()
            if suffix == '.swift':
                raise BuildError(f'{path}: Swift sources are not supported by the Linux build yet')
            if suffix in SOURCE_EXTENSIONS:
                sources.append(path)
            elif suffix in HEADER_EXTENSIONS:
                headers.append(path)
    return sources, headers


def generate_ninja(toolchain, pods_project, app_project, options):
    pods_dir = Path(pods_project['project_dir'])
    pod_targets = collect_pod_targets(pods_project)

    project_headers = {}
    for target in pod_targets:
        for header in target.get('headers', []):
            if header['path']:
                project_headers.setdefault(Path(header['path']).name, header['path'])
    pods_hmap = BUILD / 'hmap' / 'pods-project-headers.hmap'
    write_header_map(pods_hmap, project_headers)

    lines = [
        '# Generated by tools/ios-linux/build.py; do not edit.',
        'ninja_required_version = 1.7',
        f'builddir = {ninja_path(BUILD / "ninja")}',
        'rule compile',
        '  command = $compiler @$rsp $fileflags -MD -MF $out.d -c $in -o $out',
        '  depfile = $out.d',
        '  deps = gcc',
        '  description = CC [$label] $in',
        'rule archive',
        f'  command = rm -f $out && {shlex.quote(str(toolchain.llvm_ar))} --format=darwin rcs $out @$out.rsp',
        '  rspfile = $out.rsp',
        '  rspfile_content = $in_newline',
        '  description = AR $out',
        'rule link',
        f'  command = {shlex.quote(str(toolchain.lld))} @$out.rsp -o $out',
        '  rspfile = $out.rsp',
        '  rspfile_content = $linkflags',
        '  description = LINK $out',
        '',
    ]

    info = {'pods': {}, 'bundles': [], 'script_phases': []}
    libraries = []
    for target in pod_targets:
        settings = target_settings(toolchain, pods_project, target, pods_dir)
        product_type = target.get('product_type') or ''
        for phase in target.get('script_phases', []):
            info['script_phases'].append({'target': target['name'], 'phase': phase, 'settings': settings})
        if product_type.endswith('bundle'):
            info['bundles'].append({'target': target, 'settings': settings})
            continue
        if not product_type.endswith('library.static'):
            if target.get('sources'):
                raise BuildError(f"{target['name']}: unsupported product type {product_type}")
            continue
        sources = [(Path(entry['path']), split_flags(settings, entry['settings'].get('COMPILER_FLAGS', '')))
                   for entry in target.get('sources', []) if entry['path']]
        headers = [Path(header['path']) for header in target.get('headers', []) if header['path']]
        unit = CompileUnit(toolchain, target['name'], settings, sources, headers, quiet=True,
                           project_hmap=pods_hmap, optimization=options.optimization)
        objects = unit.emit(lines)
        library = Path(settings.get('CONFIGURATION_BUILD_DIR')) / target['product_reference']
        lines.append(f'build {ninja_path(library)}: archive ' + ' '.join(ninja_path(o) for o in objects))
        lines.append('')
        libraries.append(library)
        info['pods'][target['name']] = {'library': str(library), 'sources': len(objects)}

    # ---- application target -------------------------------------------------
    app_target = next(t for t in app_project['targets'] if t['name'] == APP_TARGET)
    app_dir = ROOT / 'ios'
    app_settings = target_settings(toolchain, app_project, app_target, app_dir, extra_forced={
        'PODS_ROOT': str(PODS_ROOT),
        'PODS_PODFILE_DIR_PATH': str(STAGE_IOS),
    })
    group_dirs, exceptions = [], set()
    for group in app_target.get('synchronized_groups') or []:
        group_dirs.append(app_dir / group['path'])
        exceptions.update(group.get('membership_exceptions') or [])
    if not group_dirs:
        raise BuildError('app target has no file-system-synchronised group; update build.py')
    sources, headers = app_sources_and_headers(group_dirs, exceptions)
    explicit = [Path(entry['path']) for entry in app_target.get('sources', []) if entry['path']]
    app_hmap = BUILD / 'hmap' / 'app-project-headers.hmap'
    write_header_map(app_hmap, {header.name: header for header in headers})
    unit = CompileUnit(toolchain, APP_TARGET, app_settings, [(source, []) for source in sources + explicit],
                       headers, quiet=False, project_hmap=app_hmap, optimization=options.optimization)
    app_objects = unit.emit(lines)

    link_arguments = [
        '-arch', 'arm64', '-dynamic', '-demangle',
        '-platform_version', 'ios', app_settings.get('IPHONEOS_DEPLOYMENT_TARGET'), toolchain.sdk_version,
        '-syslibroot', str(toolchain.sdk),
    ]
    if app_settings.is_yes('DEAD_CODE_STRIPPING', default=True):
        link_arguments.append('-dead_strip')
    for path in app_settings.get_list('LIBRARY_SEARCH_PATHS'):
        if Path(path).is_dir() or path.startswith(str(PRODUCTS)):
            link_arguments += ['-L', path]
    for path in app_settings.get_list('FRAMEWORK_SEARCH_PATHS'):
        if Path(path).is_dir() or path.startswith(str(PRODUCTS)):
            link_arguments += ['-F', path]
    for path in dict.fromkeys(app_settings.get_list('LD_RUNPATH_SEARCH_PATHS')):
        link_arguments += ['-rpath', path]
    link_arguments += [str(obj) for obj in app_objects]
    link_arguments += app_settings.get_list('OTHER_LDFLAGS')
    built_products = Path(app_settings.get('BUILT_PRODUCTS_DIR'))
    for entry in app_target.get('frameworks', []):
        raw = entry.get('raw_path') or ''
        if raw.endswith('.framework'):
            link_arguments += ['-framework', Path(raw).stem]
        elif raw.endswith('.a') and entry.get('source_tree') == 'BUILT_PRODUCTS_DIR':
            candidates = [lib for lib in libraries if lib.name == Path(raw).name]
            link_arguments.append(str(candidates[0] if candidates else built_products / raw))
        elif raw.endswith(('.tbd', '.dylib')):
            link_arguments.append('-l' + re.sub(r'^lib', '', Path(raw).stem))
    link_arguments += ['-framework', 'Foundation', '-lobjc', '-lc++', '-lSystem', str(toolchain.clang_rt)]

    executable = BUILD / 'link' / app_settings.get('EXECUTABLE_NAME')
    inputs = ' '.join(ninja_path(o) for o in app_objects)
    implicit = ' '.join(ninja_path(lib) for lib in libraries)
    lines.append(f'build {ninja_path(executable)}: link {inputs} | {implicit}')
    lines.append('  linkflags = ' + ninja_escape(' '.join(rsp_quote(argument) for argument in link_arguments)))
    lines.append('')
    lines.append(f'default {ninja_path(executable)}')
    write_if_changed(BUILD / 'build.ninja', '\n'.join(lines) + '\n')

    info.update({'app_settings': app_settings, 'app_target': app_target, 'executable': executable,
                 'group_dirs': group_dirs, 'exceptions': exceptions, 'app_sources': sources})
    return info


# --------------------------------------------------------------------------
# XCFrameworks, script phases
# --------------------------------------------------------------------------

def stage_xcframeworks():
    """Do what CocoaPods' `[CP] Copy XCFrameworks` script phases do: put the
    device slice of each vendored xcframework where the xcconfigs expect it
    (PODS_XCFRAMEWORKS_BUILD_DIR)."""
    intermediates = PRODUCTS / f'{CONFIGURATION}-iphoneos' / 'XCFrameworkIntermediates'
    produced = []
    for script in sorted((PODS_ROOT / 'Target Support Files').glob('*/*-xcframeworks.sh')):
        for line in script.read_text().splitlines():
            line = line.strip()
            if not line.startswith('install_xcframework '):
                continue
            arguments = shlex.split(line.replace('${PODS_ROOT}', str(PODS_ROOT)).replace('$PODS_ROOT', str(PODS_ROOT)))
            xcframework, destination_name = Path(arguments[1]), arguments[2]
            manifest = plistlib.loads((xcframework / 'Info.plist').read_bytes())
            chosen = None
            for library in manifest.get('AvailableLibraries', []):
                if library.get('SupportedPlatform') == 'ios' and not library.get('SupportedPlatformVariant') \
                        and 'arm64' in library.get('SupportedArchitectures', []):
                    chosen = library
            if chosen is None:
                raise BuildError(f'{xcframework}: no ios-arm64 device slice')
            source = xcframework / chosen['LibraryIdentifier'] / chosen['LibraryPath']
            destination = intermediates / destination_name / chosen['LibraryPath']
            produced.append(destination)
            marker = destination.parent / f'.{destination.name}.stamp'
            stamp = stat_fingerprint([source])
            if destination.exists() and marker.exists() and marker.read_text() == stamp:
                continue
            if destination.exists():
                shutil.rmtree(destination) if destination.is_dir() else destination.unlink()
            destination.parent.mkdir(parents=True, exist_ok=True)
            if source.is_dir():
                shutil.copytree(source, destination, symlinks=True)
            else:
                shutil.copy2(source, destination)
            marker.write_text(stamp)
    return produced


def run_script_phases(info, env):
    """Run the pods' own `[CP-User]` script phases (React Native codegen) with
    an Xcode-like environment. CocoaPods' `[CP]` phases are reimplemented in
    this file instead (stage_xcframeworks, pod resources, frameworks)."""
    for entry in info['script_phases']:
        phase, settings, target = entry['phase'], entry['settings'], entry['target']
        name = phase.get('name') or ''
        if not name.startswith('[CP-User]'):
            continue
        phase_env = dict(env)
        for key in settings.keys():
            if re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', key):
                phase_env[key] = settings.get(key)
        phase_env['ACTION'] = 'build'
        inputs = [settings.expand(path) for path in phase.get('input_paths') or []]
        outputs = [settings.expand(path) for path in phase.get('output_paths') or []]
        for index, path in enumerate(inputs):
            phase_env[f'SCRIPT_INPUT_FILE_{index}'] = path
        for index, path in enumerate(outputs):
            phase_env[f'SCRIPT_OUTPUT_FILE_{index}'] = path
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        phase_env['SCRIPT_INPUT_FILE_COUNT'] = str(len(inputs))
        phase_env['SCRIPT_OUTPUT_FILE_COUNT'] = str(len(outputs))
        # React Native's script_phases.sh does `pushd "$RN_DIR"` with RN_DIR
        # unset. macOS's bash 3.2 treats that as a no-op; bash 5 rejects it.
        phase_env.setdefault('RN_DIR', '.')
        slug = re.sub(r'[^A-Za-z0-9]+', '-', f'{target}-{name}').strip('-')
        stamp = stat_fingerprint(inputs, extra=[phase['script'], sorted(outputs)])
        # `pod install` leaves empty placeholders for generated sources, so an
        # existing but empty output still means the phase has to run.
        if stamp_matches(f'script-{slug}', stamp) and all(
                Path(path).exists() and Path(path).stat().st_size > 0 for path in outputs):
            continue
        log(f'script phase: {target} {name}')
        Path(settings.get('DERIVED_FILE_DIR')).mkdir(parents=True, exist_ok=True)
        shell = phase.get('shell_path') or '/bin/sh'
        if shell == '/bin/sh':
            shell = '/bin/bash'  # /bin/sh is bash on macOS; these scripts rely on it
        run([shell, '-c', phase['script']], env=phase_env, cwd=settings.get('SRCROOT'),
            log_path=ART / 'logs' / f'script-{slug}.log')
        write_stamp(f'script-{slug}', stamp)


# --------------------------------------------------------------------------
# JavaScript bundle
# --------------------------------------------------------------------------

def stage_js_bundle(env, toolchain, options):
    js_dir = BUILD / 'js'
    bundle = js_dir / 'main.jsbundle'
    watched = [ROOT / 'src', ROOT / 'index.js', ROOT / 'app.json', ROOT / 'package.json', ROOT / 'yarn.lock',
               ROOT / 'metro.config.js', ROOT / 'babel.config.js', ROOT / 'titles.json', ROOT / 'patches']
    stamp = stat_fingerprint(watched, extra=['js-v1', options.hermesc])
    if bundle.exists() and stamp_matches('js', stamp):
        return bundle, js_dir / 'assets'
    log('bundling JavaScript with Metro')
    shutil.rmtree(js_dir, ignore_errors=True)
    js_dir.mkdir(parents=True)
    plain = js_dir / 'main.jsbundle.js'
    command = [toolchain.node, ROOT / 'node_modules/react-native/cli.js', 'bundle',
               '--entry-file', 'index.js', '--platform', 'ios', '--dev', 'false',
               '--bundle-output', plain, '--assets-dest', js_dir]
    if options.hermesc:
        command += ['--minify', 'false']  # as react-native-xcode.sh does when Hermes compiles the bundle
    run(command, env=env, cwd=ROOT, log_path=ART / 'logs' / 'metro-bundle.log')
    if options.hermesc:
        hermesc = ROOT / 'node_modules/react-native/sdks/hermesc/linux64-bin/hermesc'
        if not hermesc.is_file():
            raise BuildError(f'hermesc not found at {hermesc}')
        log('compiling bundle to Hermes bytecode')
        run([hermesc, '-emit-binary', '-max-diagnostic-width=80', '-O', '-out', bundle, plain],
            log_path=ART / 'logs' / 'hermesc.log')
    else:
        shutil.copy2(plain, bundle)
    write_stamp('js', stamp)
    return bundle, js_dir / 'assets'


# --------------------------------------------------------------------------
# App bundle assembly
# --------------------------------------------------------------------------

ICON_VARIANTS = [
    # (base name, point size, scale, idiom suffix)
    ('AppIcon20x20', 20, 2, ''), ('AppIcon20x20', 20, 3, ''),
    ('AppIcon29x29', 29, 2, ''), ('AppIcon29x29', 29, 3, ''),
    ('AppIcon40x40', 40, 2, ''), ('AppIcon40x40', 40, 3, ''),
    ('AppIcon60x60', 60, 2, ''), ('AppIcon60x60', 60, 3, ''),
    ('AppIcon20x20', 20, 1, '~ipad'), ('AppIcon20x20', 20, 2, '~ipad'),
    ('AppIcon29x29', 29, 1, '~ipad'), ('AppIcon29x29', 29, 2, '~ipad'),
    ('AppIcon40x40', 40, 1, '~ipad'), ('AppIcon40x40', 40, 2, '~ipad'),
    ('AppIcon76x76', 76, 1, '~ipad'), ('AppIcon76x76', 76, 2, '~ipad'),
    ('AppIcon83.5x83.5', 83.5, 2, '~ipad'),
]


def copy_resource(source, app, name=None, seen=None):
    destination = app / (name or source.name)
    if seen is not None:
        key = destination.name.lower()
        if key in seen and seen[key] != source:
            raise BuildError(f'resource name collision in app bundle: {source} and {seen[key]}')
        seen[key] = source
    if source.is_dir():
        if destination.exists():
            shutil.rmtree(destination)
        shutil.copytree(source, destination, symlinks=True, ignore=shutil.ignore_patterns('.DS_Store'))
    else:
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)


def install_app_icons(appiconset, app, plist):
    """actool is unavailable on Linux: emit the loose icon PNGs it would have
    written next to Assets.car and declare them through CFBundleIcons."""
    from PIL import Image
    contents = json.loads((appiconset / 'Contents.json').read_text())
    source = next((appiconset / image['filename'] for image in contents.get('images', [])
                   if image.get('filename') and not image.get('appearances')), None)
    if source is None or not source.exists():
        log(f'warning: no usable icon in {appiconset}; the app will have a blank icon')
        return
    image = Image.open(source)
    if image.mode == 'RGBA' and image.getextrema()[3][0] == 255:
        image = image.convert('RGB')
    for base, points, scale, idiom in ICON_VARIANTS:
        pixels = round(points * scale)
        suffix = f'@{scale}x' if scale > 1 else ''
        image.resize((pixels, pixels), Image.LANCZOS).save(app / f'{base}{suffix}{idiom}.png', format='PNG')
    plist['CFBundleIcons'] = {'CFBundlePrimaryIcon': {
        'CFBundleIconFiles': ['AppIcon20x20', 'AppIcon29x29', 'AppIcon40x40', 'AppIcon60x60']}}
    plist['CFBundleIcons~ipad'] = {'CFBundlePrimaryIcon': {
        'CFBundleIconFiles': ['AppIcon20x20', 'AppIcon29x29', 'AppIcon40x40', 'AppIcon60x60',
                              'AppIcon76x76', 'AppIcon83.5x83.5']}}


def install_asset_catalogs(group_dirs, app, plist, settings, seen):
    icon_name = settings.get('ASSETCATALOG_COMPILER_APPICON_NAME')
    for group in group_dirs:
        for catalog in sorted(group.rglob('*.xcassets')):
            for imageset in sorted(catalog.rglob('*.imageset')):
                contents = json.loads((imageset / 'Contents.json').read_text())
                for image in contents.get('images', []):
                    if not image.get('filename'):
                        continue
                    source = imageset / image['filename']
                    scale = image.get('scale', '1x')
                    suffix = '' if scale == '1x' else f'@{scale}'
                    copy_resource(source, app, f'{imageset.stem}{suffix}{source.suffix}', seen)
            if icon_name and (catalog / f'{icon_name}.appiconset').is_dir():
                install_app_icons(catalog / f'{icon_name}.appiconset', app, plist)
            unsupported = [p.name for p in catalog.rglob('*') if p.is_dir() and p.suffix in
                           {'.colorset', '.dataset', '.symbolset', '.imagestack', '.brandassets'}]
            if unsupported:
                log(f'warning: {catalog.name} has entries that need actool and are skipped: {", ".join(unsupported)}')


def launch_screen_from_storyboard(group_dirs, app):
    """ibtool is unavailable on Linux: translate the launch storyboard into the
    equivalent UILaunchScreen dictionary (its image view, if any)."""
    launch = {}
    for group in group_dirs:
        for storyboard in sorted(group.rglob('*.storyboard')):
            try:
                root = ElementTree.parse(storyboard).getroot()
            except ElementTree.ParseError:
                continue
            if root.get('launchScreen') != 'YES':
                log(f'warning: {storyboard} is not a launch screen and cannot be compiled on Linux; skipped')
                continue
            image_view = root.find('.//imageView[@image]')
            if image_view is not None:
                name = image_view.get('image')
                if any((app / f'{name}{suffix}').exists() for suffix in ('.png', '@2x.png', '@3x.png', '.jpg')):
                    launch['UIImageName'] = name
                    launch['UIImageRespectsSafeAreaInsets'] = root.get('useSafeAreas') == 'YES'
    return launch


def install_group_resources(group_dirs, exceptions, app, seen):
    """A file-system-synchronised group copies every non-source file into the
    bundle root, flattening sub-folders (index.html's ./x.js paths rely on it)."""
    for group in group_dirs:
        for path in sorted(group.rglob('*')):
            relative = path.relative_to(group)
            parts = relative.parts
            if path.name == '.DS_Store' or relative.as_posix() in exceptions or path.name in exceptions:
                continue
            container = next((i for i, part in enumerate(parts[:-1])
                              if Path(part).suffix in {'.xcassets', '.bundle', '.framework', '.lproj', '.scnassets'}), None)
            if path.is_dir():
                if path.suffix in {'.bundle', '.scnassets'} and container is None:
                    copy_resource(path, app, seen=seen)
                continue
            suffix = path.suffix if path.suffix == '.S' else path.suffix.lower()
            if suffix in SOURCE_EXTENSIONS or suffix in HEADER_EXTENSIONS or suffix in {'.swift', '.entitlements', '.xcconfig'}:
                continue
            if suffix in APPLE_COMPILED_RESOURCES:
                continue  # handled by install_asset_catalogs / launch_screen_from_storyboard
            if container is not None:
                holder = Path(parts[container])
                if holder.suffix == '.lproj':
                    copy_resource(path, app, str(Path(holder.name) / Path(*parts[container + 1:])))
                continue
            copy_resource(path, app, seen=seen)


def build_resource_bundles(info):
    for entry in info['bundles']:
        target, settings = entry['target'], entry['settings']
        bundle = Path(settings.get('CONFIGURATION_BUILD_DIR')) / f"{settings.get('PRODUCT_NAME')}.bundle"
        if bundle.exists():
            shutil.rmtree(bundle)
        bundle.mkdir(parents=True)
        for resource in target.get('resources', []):
            source = Path(resource['path'])
            if source.suffix in APPLE_COMPILED_RESOURCES:
                raise BuildError(f"{target['name']}: {source.name} needs an Apple resource compiler")
            copy_resource(source, bundle)
        plist_path = settings.get('INFOPLIST_FILE')
        if plist_path:
            plist_path = Path(plist_path) if os.path.isabs(plist_path) else Path(settings.get('SRCROOT')) / plist_path
            plist = expand_plist(plistlib.loads(plist_path.read_bytes()), settings)
            plist.setdefault('CFBundleIdentifier', settings.get('PRODUCT_BUNDLE_IDENTIFIER'))
            plist.pop('CFBundleExecutable', None)
            (bundle / 'Info.plist').write_bytes(plistlib.dumps(plist, fmt=plistlib.FMT_BINARY))


def expand_plist(value, settings):
    if isinstance(value, dict):
        return {key: expand_plist(item, settings) for key, item in value.items()}
    if isinstance(value, list):
        return [expand_plist(item, settings) for item in value]
    if isinstance(value, str):
        return settings.expand(value)
    return value


def pods_script_entries(script_name, function):
    """Arguments of `function "..."` calls in the Release branch (and the
    unconditional part) of a CocoaPods-generated support script."""
    script = PODS_ROOT / 'Target Support Files' / PODS_AGGREGATE_TARGET / script_name
    if not script.exists():
        return []
    entries, active = [], True
    for line in script.read_text().splitlines():
        stripped = line.strip()
        match = re.match(r'if \[\[ "\$CONFIGURATION" == "([^"]+)" \]\]; then', stripped)
        if match:
            active = match.group(1) == CONFIGURATION
            continue
        if stripped == 'fi' and not line.startswith(' '):
            active = True
            continue
        if active and stripped.startswith(function + ' ') and line.startswith('  '):
            entries.append(shlex.split(stripped)[1])
    return entries


def info_plist(settings, toolchain, options):
    source = settings.get('INFOPLIST_FILE')
    plist = {}
    if source:
        path = Path(source) if os.path.isabs(source) else Path(settings.get('SRCROOT')) / source
        plist = expand_plist(plistlib.loads(path.read_bytes()), settings)
    list_keys = {'UISupportedInterfaceOrientations', 'UIRequiredDeviceCapabilities', 'UIBackgroundModes'}
    for key in sorted(settings.keys()):
        if not key.startswith('INFOPLIST_KEY_'):
            continue
        name, value = key[len('INFOPLIST_KEY_'):], settings.get(key)
        if value == '':
            continue
        for idiom in ('iPad', 'iPhone'):
            if name.endswith('_' + idiom):
                name = f"{name[:-len(idiom) - 1]}~{idiom.lower()}"
        base = name.split('~')[0]
        if base in list_keys:
            plist[name] = value.split()
        elif value in ('YES', 'NO'):
            plist[name] = value == 'YES'
        else:
            plist[name] = value
    deployment = settings.get('IPHONEOS_DEPLOYMENT_TARGET')
    plist.update({
        'CFBundleDevelopmentRegion': settings.get('DEVELOPMENT_LANGUAGE') or 'en',
        'CFBundleExecutable': settings.get('EXECUTABLE_NAME'),
        'CFBundleIdentifier': options.bundle_id,
        'CFBundleInfoDictionaryVersion': '6.0',
        'CFBundleName': settings.get('PRODUCT_NAME'),
        'CFBundleDisplayName': options.display_name,
        'CFBundlePackageType': 'APPL',
        'CFBundleShortVersionString': settings.get('MARKETING_VERSION') or '1.0',
        'CFBundleVersion': settings.get('CURRENT_PROJECT_VERSION') or '1',
        'CFBundleSupportedPlatforms': ['iPhoneOS'],
        'LSRequiresIPhoneOS': True,
        'MinimumOSVersion': deployment,
        'UIDeviceFamily': [int(family) for family in re.split(r'[,\s]+', settings.get('TARGETED_DEVICE_FAMILY') or '1,2') if family],
        # Xcode rewrites the project's armv7 capability to arm64 for arm64-only builds.
        'UIRequiredDeviceCapabilities': ['arm64'],
        'DTPlatformName': 'iphoneos',
        'DTPlatformVersion': toolchain.sdk_version,
        'DTSDKName': toolchain.sdk_name,
    })
    plist.pop('UILaunchStoryboardName', None)
    plist.pop('UIMainStoryboardFile', None)
    return plist


def assemble_app(info, toolchain, bundle, assets, options):
    settings = info['app_settings']
    app = OUT / f"{settings.get('PRODUCT_NAME')}.app"
    log(f'assembling {app.relative_to(ROOT)}')
    if app.exists():
        shutil.rmtree(app)
    app.mkdir(parents=True)
    seen = {}
    executable = app / settings.get('EXECUTABLE_NAME')
    shutil.copy2(info['executable'], executable)
    executable.chmod(0o755)
    (app / 'PkgInfo').write_bytes(b'APPL????')

    plist = info_plist(settings, toolchain, options)
    install_group_resources(info['group_dirs'], info['exceptions'], app, seen)
    install_asset_catalogs(info['group_dirs'], app, plist, settings, seen)
    plist['UILaunchScreen'] = launch_screen_from_storyboard(info['group_dirs'], app)

    # Resources build phase of the app target (main.jsbundle comes from Metro).
    for entry in info['app_target'].get('resources', []):
        name = Path(entry.get('raw_path') or entry.get('path') or '').name
        if name == 'main.jsbundle':
            copy_resource(bundle, app, 'main.jsbundle', seen)
        elif entry.get('path') and Path(entry['path']).exists():
            copy_resource(Path(entry['path']), app, seen=seen)
        else:
            log(f'warning: resource {name} listed in the Xcode project does not exist; skipped')
    if not (app / 'main.jsbundle').exists():
        copy_resource(bundle, app, 'main.jsbundle', seen)
    # Images that the JS bundle resolves relative to main.jsbundle.
    if assets.is_dir():
        copy_resource(assets, app, 'assets')

    # [CP] Copy Pods Resources
    build_resource_bundles(info)
    for entry in pods_script_entries(f'{PODS_AGGREGATE_TARGET}-resources.sh', 'install_resource'):
        source = Path(settings.expand(entry))
        if not source.exists():
            raise BuildError(f'pod resource missing: {source}')
        if source.suffix in APPLE_COMPILED_RESOURCES:
            raise BuildError(f'pod resource {source.name} needs an Apple resource compiler')
        copy_resource(source, app, seen=seen)

    # [CP] Embed Pods Frameworks
    for entry in pods_script_entries(f'{PODS_AGGREGATE_TARGET}-frameworks.sh', 'install_framework'):
        source = Path(settings.expand(entry))
        if not source.exists():
            raise BuildError(f'framework to embed is missing: {source}')
        destination = app / 'Frameworks' / source.name
        shutil.copytree(source, destination, symlinks=True,
                        ignore=shutil.ignore_patterns('Headers', 'PrivateHeaders', 'Modules', '*.dSYM', '_CodeSignature'))
        for binary in destination.iterdir():
            if binary.is_file() and binary.suffix == '':
                binary.chmod(0o755)

    (app / 'Info.plist').write_bytes(plistlib.dumps(plist, fmt=plistlib.FMT_BINARY))
    return app, plist


def write_ipa(app, ipa):
    ipa.parent.mkdir(parents=True, exist_ok=True)
    if ipa.exists():
        ipa.unlink()
    with zipfile.ZipFile(ipa, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for path in sorted(app.rglob('*')):
            name = (Path('Payload') / app.name / path.relative_to(app)).as_posix()
            if path.is_symlink():
                entry = zipfile.ZipInfo(name)
                entry.create_system = 3
                entry.external_attr = (0o120777 << 16)
                archive.writestr(entry, os.readlink(path))
            elif path.is_file():
                archive.write(path, name)
    return ipa


# --------------------------------------------------------------------------
# Provenance
# --------------------------------------------------------------------------

def write_toolchain_record(toolchain, options):
    hermes = PODS_ROOT / 'hermes-engine/destroot/Library/Frameworks/universal/hermes.xcframework/ios-arm64/hermes.framework/hermes'
    package = json.loads((ROOT / 'node_modules/react-native/package.json').read_text())
    record = {
        'generated_by': 'tools/ios-linux/build.py',
        'downloads': [
            {**PORTABLE_RUBY, 'used_for': 'running CocoaPods'},
            {**YARN, 'used_for': 'installing node_modules (packageManager field)'},
        ],
        'rubygems': {
            'lockfile': 'tools/ios-linux/Gemfile.lock',
            'lockfile_sha256': sha256_file(TOOLS / 'Gemfile.lock'),
            'note': 'every gem is pinned with a sha256 in the CHECKSUMS section; bundler runs frozen',
            'cocoapods': '1.16.2',
        },
        'cocoapods_resolution': {
            'podfile_lock_sha256': sha256_file(ROOT / 'ios/Podfile.lock'),
            'hermes_engine': {
                'source': f"https://repo1.maven.org/maven2/com/facebook/react/react-native-artifacts/{package['version']}/"
                          f"react-native-artifacts-{package['version']}-hermes-ios-release.tar.gz",
                'ios_arm64_binary_sha256': sha256_file(hermes) if hermes.exists() else None,
            },
        },
        'react_native': package['version'],
        'compiler': {'path': str(toolchain.clang), 'version': toolchain.version_of(toolchain.clang)},
        'linker': {'path': str(toolchain.lld), 'version': toolchain.version_of(toolchain.lld)},
        'archiver': {'path': str(toolchain.llvm_ar), 'version': toolchain.version_of(toolchain.llvm_ar)},
        'ios_sdk': {'path': str(toolchain.sdk), 'version': toolchain.sdk_version, 'name': toolchain.sdk_name},
        'compiler_runtime': str(toolchain.clang_rt),
        'node': toolchain.version_of(toolchain.node),
        'ninja': toolchain.version_of(toolchain.ninja),
        'hermesc': 'node_modules/react-native/sdks/hermesc/linux64-bin/hermesc',
        'app': {'bundle_id': options.bundle_id, 'display_name': options.display_name},
    }
    write_if_changed(ART / 'toolchain.json', json.dumps(record, indent=2) + '\n')


# --------------------------------------------------------------------------
# Commands
# --------------------------------------------------------------------------

def command_build(options):
    started = time.monotonic()
    timings = {}

    def timed(label, function, *arguments):
        begin = time.monotonic()
        result = function(*arguments)
        timings[label] = round(time.monotonic() - begin, 1)
        return result

    for directory in (ART, TMP, BUILD, OUT, STAMPS):
        directory.mkdir(parents=True, exist_ok=True)
    toolchain = Toolchain()
    env = base_env(toolchain)
    apple_env = base_env(toolchain, apple_shims=True)

    timed('yarn', stage_yarn, env, toolchain)
    timed('ruby+gems', stage_ruby, env)
    pods_changed = timed('pod install', stage_pods, apple_env)
    pods_project, app_project = timed('project dump', dump_projects, env, pods_changed)
    timed('xcframeworks', stage_xcframeworks)
    info = timed('ninja generation', generate_ninja, toolchain, pods_project, app_project, options)
    timed('script phases', run_script_phases, info, apple_env)
    bundle, assets = timed('js bundle', stage_js_bundle, env, toolchain, options)

    log(f'compiling and linking with ninja -j{options.jobs}')
    ninja_env = dict(os.environ)
    ninja_env['TMPDIR'] = str(TMP)
    ninja_command = [toolchain.ninja, '-f', BUILD / 'build.ninja', '-j', str(options.jobs)]
    if options.verbose:
        ninja_command.append('-v')
    timed('compile+link', lambda: run(ninja_command, env=ninja_env))
    app, plist = timed('assemble', assemble_app, info, toolchain, bundle, assets, options)
    ipa = timed('ipa', write_ipa, app, OUT / 'XStreaming-Dev-unsigned.ipa')
    write_toolchain_record(toolchain, options)

    total = round(time.monotonic() - started, 1)
    summary = {
        'app': str(app), 'ipa': str(ipa), 'ipa_sha256': sha256_file(ipa),
        'bundle_id': plist['CFBundleIdentifier'], 'display_name': plist['CFBundleDisplayName'],
        'version': f"{plist['CFBundleShortVersionString']} ({plist['CFBundleVersion']})",
        'seconds': timings, 'total_seconds': total,
        'pod_libraries': len(info['pods']), 'app_sources': [str(p.relative_to(ROOT)) for p in info['app_sources']],
    }
    (OUT / 'build-summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    log('stage timings (s): ' + ', '.join(f'{name} {seconds}' for name, seconds in timings.items()))
    log(f'built {ipa.relative_to(ROOT)} in {total}s')
    return ipa, plist


def connected_device(options):
    if options.udid:
        return options.udid
    devices = capture(['idevice_id', '--list']).split()
    if len(devices) != 1:
        raise BuildError(f'expected exactly one USB device, found {len(devices)}; pass --udid')
    return devices[0]


def installed_identifier(udid, bundle_id):
    """xtool prefixes the bundle id when it signs (XTL-<team>.<bundle id>)."""
    listing = json.loads(capture(['pymobiledevice3', 'apps', 'list', '--type', 'User', '--udid', udid]))
    matches = [identifier for identifier in listing
               if identifier == bundle_id or (identifier.startswith('XTL-') and identifier.partition('.')[2] == bundle_id)]
    if len(matches) != 1:
        raise BuildError(f'expected one installed copy of {bundle_id}, found {matches or "none"}')
    return matches[0], listing[matches[0]]


def command_deploy(options):
    ipa, plist = command_build(options)
    for tool in ('ipad-dev', 'pymobiledevice3', 'idevice_id'):
        if not shutil.which(tool):
            raise BuildError(f'{tool} is not on PATH')
    udid = connected_device(options)
    log(f'signing and installing on {udid} (ipad-dev install)')
    run(['ipad-dev', 'install', ipa, udid])
    identifier, metadata = installed_identifier(udid, plist['CFBundleIdentifier'])
    log(f"installed as {identifier}: {metadata.get('CFBundleDisplayName')} "
        f"{metadata.get('CFBundleShortVersionString')} ({metadata.get('CFBundleVersion')})")
    (OUT / 'installed.json').write_text(json.dumps({
        'udid': udid, 'identifier': identifier,
        'display_name': metadata.get('CFBundleDisplayName'),
        'version': metadata.get('CFBundleShortVersionString'), 'build': metadata.get('CFBundleVersion'),
        'ipa_sha256': sha256_file(ipa),
    }, indent=2) + '\n')
    if options.no_launch:
        return
    log('launching (the iPad must be unlocked)')
    run(['ipad-dev', 'launch', identifier, udid])


def command_clean(options):
    targets = [BUILD, OUT, STAGE, STAMPS, TMP]
    if options.all:
        targets = [ART]
    for target in targets:
        if target.exists():
            log(f'removing {target.relative_to(ROOT)}')
            shutil.rmtree(target)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    subparsers = parser.add_subparsers(dest='command', required=True)

    def add_build_options(sub):
        sub.add_argument('--jobs', '-j', type=int, default=max(1, (os.cpu_count() or 2) // 2),
                         help='parallel compile jobs (default: half the cores)')
        sub.add_argument('--bundle-id', default=DEFAULT_BUNDLE_ID)
        sub.add_argument('--display-name', default=DEFAULT_DISPLAY_NAME)
        sub.add_argument('--optimization', default=None, help="override GCC_OPTIMIZATION_LEVEL (e.g. 0, 2, s)")
        sub.add_argument('--no-hermesc', dest='hermesc', action='store_false',
                         help='ship plain JavaScript and let Hermes compile it on the device')
        sub.add_argument('--verbose', '-v', action='store_true', help='show full compiler command lines')

    build = subparsers.add_parser('build', help='build the unsigned .app and .ipa')
    add_build_options(build)
    deploy = subparsers.add_parser('deploy', help='build, install on the USB-connected iPad, launch')
    add_build_options(deploy)
    deploy.add_argument('--udid', default=None)
    deploy.add_argument('--no-launch', action='store_true')
    clean = subparsers.add_parser('clean', help='remove build output')
    clean.add_argument('--all', action='store_true', help='also remove downloads and caches')

    options = parser.parse_args()
    try:
        {'build': command_build, 'deploy': command_deploy, 'clean': command_clean}[options.command](options)
    except BuildError as error:
        print(f'[ios-linux] error: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
