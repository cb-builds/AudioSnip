# AudioSnip

AudioSnip is a Windows background utility that continuously records a rolling
buffer of audio from multiple input/output devices at once, and lets you
pull a clip out of it - trim, fade, mix, and export to MP3 - the moment
something worth keeping just happened, without ever having pressed "record"
in advance.

It sits quietly in the system tray. Press a global hotkey, and whatever was
captured in the last N seconds (30 by default) across every enabled device
opens up in a full multi-track editor.

## How it works

1. **Pick your sources.** AudioSnip enumerates every capturable audio
   device - microphones/line inputs directly, and speakers/output devices
   via WASAPI loopback (so you can capture "what you hear," e.g. game audio,
   a browser tab, a voice chat app) - and you toggle on whichever ones you
   want recorded.
2. **It buffers continuously in the background**, each enabled device into
   its own lock-free rolling buffer holding the last configured number of
   seconds, discarding older audio as new audio comes in. Nothing is written
   to disk until you actually capture a clip.
3. **Press the capture hotkey** (`Ctrl+Shift+K` by default) and the app
   snapshots every active device's buffer, scaled to however much audio has
   actually accumulated (so capturing 5 seconds after opening the app gives
   you a 5-second clip, not 30 seconds of padded silence), and opens the
   editor.
4. **Edit.** Each source gets its own waveform, plus a Master Mix view that
   overlays every source's waveform on the same timeline. Per source (and
   for the mix as a whole) you can adjust volume/gain, trim the start and
   end, apply fade in/out, nudge a source's timing to fix sync drift, mute a
   source from the mix, and preview playback of any individual track or the
   full mix.
5. **Export.** Mixes down whichever sources are still enabled into a single
   320kbps MP3 and prompts you for where to save it.

If a clip is already loaded and you trigger another capture (via the
hotkey, the tray, or the in-app button), AudioSnip holds the new capture in
memory and asks - with its own themed dialog, not a native OS prompt - before
overwriting what's on screen.

## Features

- **Multi-channel, simultaneous capture** - any number of input and loopback
  output devices at once, toggled individually.
- **Dynamic clip length** - a capture always reflects how much audio was
  actually recorded, never padded out to the configured buffer maximum.
- **Master Mix overlay** - every source's waveform layered on the same
  timeline for lag-free scrubbing, with real playback summed acoustically
  through the Web Audio API rather than a pre-mixed buffer.
- **Per-track and master-level editing** - volume/dB with one-click Amplify,
  trim, fade in/out, per-source scrub offset for sync correction, and a
  link/unlink toggle for master-mix volume overrides.
- **Global hotkeys** - customizable bindings for Capture Snip, Show App, and
  Reset Buffer, plus matching entries in the system tray menu.
- **System tray integration** - minimize/close to tray, with the window
  reliably restored (unminimize, show, focus) from the tray icon, its menu,
  or the hotkey.
- **Run at Startup** - optional launch-on-login, with a "start minimized"
  mode that keeps the window hidden in the tray on an autostart launch.
- **Persistent settings** - hotkey bindings, enabled devices, per-device
  default volumes, tray/startup behavior, and buffer duration are all saved
  to the OS app-data directory and restored automatically.
- **Custom, silent confirmation dialogs** - the overwrite and buffer-reset
  prompts are themed in-app modals, not native OS dialogs, so no system
  notification sound plays.

## Tech stack

- **Frontend:** React 19, TypeScript, Tailwind CSS, Vite
- **Backend/shell:** Tauri v2 (Rust)
- **Audio capture:** [`cpal`](https://crates.io/crates/cpal) over WASAPI
  (loopback for outputs, direct for inputs), with a lock-free ring buffer
  feeding the realtime audio callback
- **Encoding:** `mp3lame-encoder` (LAME) for MP3 export

The Windows-specific capture backend sits behind a `CaptureBackend` trait so
a Linux backend can be added later without touching the shared
mixing/export/UI code.

## Getting started

Requires Node.js, Rust (with the `stable-x86_64-pc-windows-msvc` toolchain),
and the Tauri CLI prerequisites for Windows.

```sh
npm install
npm run tauri dev
```

This starts the Vite dev server and launches the app in a Tauri window with
hot reload.

### Other commands

| Command | Description |
| --- | --- |
| `npm run dev` | Frontend-only Vite dev server |
| `npm run build` | Type-check and build the frontend (`tsc && vite build`) |
| `npm run tauri build` | Build the production app and NSIS installer |

### Building the installer

```sh
npm run tauri build
```

Produces an NSIS installer at
`src-tauri/target/release/bundle/nsis/AudioSnip_<version>_x64-setup.exe`.
Uninstalling offers to delete the app's AppData/Roaming settings for a clean
slate.

## Project layout

```
src/                  React frontend (UI, hooks, audio-editing math)
src-tauri/src/
  audio/              Capture backend, ring buffer, mixer, MP3 encoder
  commands.rs         Tauri commands exposed to the frontend
  hotkey.rs           Global hotkey registration and capture trigger flow
  settings_store.rs   Persisted settings (AppData JSON)
  tray.rs             System tray icon and menu
  lib.rs              App setup/wiring
src-tauri/nsis/       Custom NSIS installer hooks
```

See `REQUIREMENTS.md` for the original feature spec and `CLAUDE.md` for
project-specific coding conventions.
