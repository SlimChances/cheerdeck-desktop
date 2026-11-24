# cheerdeck-desktop

The CheerDeck desktop app for Windows: your [CheerDeck](https://cheerdeck.com) panel in its own window, with a tray icon.

**Download:** [CheerDeck-Setup.exe](https://github.com/SlimChances/cheerdeck-desktop/releases/latest/download/CheerDeck-Setup.exe). The app updates itself from the releases on this page.

## What it does

- **The panel in a window.** Opens cheerdeck.com and keeps you logged in. Closing the window hides it to the tray; quit from the tray icon.
- **Game keystrokes.** When an Action fires a keystroke (`{F8}`, `{MOUSE_CLICK_LEFT}`…), the app types it into the window in front, so gifts and commands can press keys in your game. It never types into CheerDeck itself.
- **Sign in with TikTok.** Log in on TikTok's own page in an app window. The app copies only the `sessionid` and `tt-target-idc` cookies into your CheerDeck settings. It never reads your password, and never logs or shows the session ID.
- **Chat bot posting (1.3.0+).** The Elite chat bot can post into your TikTok LIVE chat for free. The app opens your LIVE page in a hidden, muted window (signed in with the account from *Sign in with TikTok*), types the bot's message into TikTok's chat box and presses Enter. It only types messages your CheerDeck panel sends, and it blocks the video so it uses no extra bandwidth. Tray icon → **Show TikTok chat window** shows what it sees.

## Build from source

Requires Node.js 18+ on Windows.

```powershell
cd companion-app
npm ci
npm start            # run from source (points at https://cheerdeck.com)
npm run dist         # builds dist\CheerDeck-Setup.exe, .blockmap and latest.yml
```

A release must include all three files from `dist\` (`CheerDeck-Setup.exe`, `CheerDeck-Setup.exe.blockmap`, `latest.yml`), or installed apps can't update. Bump `version` in `package.json` first: the updater only moves to a higher version.

The app isn't code-signed yet, so Windows SmartScreen warns on first install.

## Changes

- **1.3.0:** the chat bot posts into your TikTok LIVE chat through the app; tray item *Show TikTok chat window*.
- **1.2.1:** real CheerDeck logo as the tray icon.
- **1.2.0:** Sign in with TikTok.
- **1.1.0:** self-update from GitHub releases.
