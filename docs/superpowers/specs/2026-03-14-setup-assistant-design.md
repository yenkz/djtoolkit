# Setup Assistant — Design Spec

## Context

The djtoolkit local agent requires five terminal commands to configure: register an agent in the web UI, copy the API key, run `djtoolkit agent configure --api-key ...`, enter Soulseek credentials, then run `djtoolkit agent install`. Most users won't complete this. The Setup Assistant is a native SwiftUI macOS app that replaces all of these steps with a guided wizard — no terminal, no web UI visit.

---

## Architecture

### Overview

A standalone SwiftUI macOS app (`DJToolkit Setup.app`) that:

1. Authenticates the user via OAuth (browser redirect to Supabase Auth)
2. Auto-registers an agent via the cloud API
3. Collects Soulseek credentials and optional AcoustID key
4. Stores everything in macOS Keychain
5. Writes `~/.djtoolkit/config.toml`
6. Installs and starts the LaunchAgent daemon

The app calls the existing `djtoolkit` CLI binary under the hood via `Process` — same codepath as the terminal flow, just GUI-driven.

### Component Diagram

```
┌──────────────────────────────────────────────┐
│           DJToolkit Setup.app (SwiftUI)       │
│                                              │
│  ┌──────────┐  ┌──────────┐  ┌────────────┐ │
│  │ Welcome  │→ │ Sign In  │→ │ Soulseek   │ │
│  │  View    │  │  View    │  │  View      │ │
│  └──────────┘  └──────────┘  └────────────┘ │
│                     │              │         │
│                     ▼              ▼         │
│  ┌──────────┐  ┌──────────┐  ┌────────────┐ │
│  │  Done    │← │ Confirm  │← │ AcoustID   │ │
│  │  View    │  │ +Advanced│  │  View      │ │
│  └──────────┘  └──────────┘  └────────────┘ │
│       │             │                        │
│       │             ▼                        │
│       │     ┌──────────────┐                 │
│       │     │ CLIBridge    │                 │
│       │     │ (Process)    │                 │
│       │     └──────┬───────┘                 │
└───────┼────────────┼─────────────────────────┘
        │            │
        │            ▼
        │    ┌──────────────┐     ┌───────────────┐
        │    │ djtoolkit    │     │ macOS Keychain │
        │    │ CLI binary   │────▶│ (keyring)      │
        │    └──────┬───────┘     └───────────────┘
        │           │
        │           ▼
        │    ┌──────────────┐     ┌───────────────┐
        │    │ launchd      │     │ ~/.djtoolkit/  │
        │    │ (plist)      │     │ config.toml    │
        │    └──────────────┘     └───────────────┘
        │
        ▼
  Browser → Supabase Auth → JWT callback
        │
        ▼
  POST /api/agents/register (with JWT)
        │
        ▼
  Returns djt_xxx API key (one-time)
```

---

## OAuth Flow

### Mechanism: `ASWebAuthenticationSession`

Apple's built-in API for OAuth in macOS apps. Opens a system-managed browser sheet, handles the redirect callback, and returns the result to the app. No custom HTTP server needed.

### Flow

1. User clicks "Sign In" in the wizard
2. App opens `ASWebAuthenticationSession` with URL:
   ```
   https://<supabase-project>.supabase.co/auth/v1/authorize?provider=google
     &redirect_to=djtoolkit://auth/callback
   ```
   (Or email/password via Supabase's hosted auth page — provider-agnostic)
3. User authenticates in the browser
4. Supabase redirects to `djtoolkit://auth/callback#access_token=<JWT>&...`
5. App receives the JWT via the custom URL scheme handler
6. App calls `POST /api/agents/register` with the JWT to get the `djt_xxx` API key
7. App stores the API key in Keychain immediately

### Custom URL Scheme

Register `djtoolkit://` as a custom URL scheme in the app's `Info.plist`:

```xml
<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleURLSchemes</key>
    <array>
      <string>djtoolkit</string>
    </array>
    <key>CFBundleURLName</key>
    <string>com.djtoolkit.setup</string>
  </dict>
</array>
```

### New API Endpoint

The existing `/api/agents/register` endpoint requires a `machine_name` in the body. The Setup Assistant will send the Mac's hostname (from `Host.current().localizedName`). No API changes needed.

---

## Wizard Steps

### Step 1: Welcome

- App icon + "Set up djtoolkit on this Mac"
- Brief description: "djtoolkit downloads, fingerprints, and tags your DJ music library. This wizard will connect your Mac to your djtoolkit account."
- Single "Get Started" button

### Step 2: Sign In

- "Sign in to your djtoolkit account" heading
- "Sign In with Browser" button → triggers `ASWebAuthenticationSession`
- While waiting: spinner + "Waiting for sign-in..."
- On success:
  - Receives JWT from callback
  - Calls `POST /api/agents/register` with JWT and machine name
  - Receives `djt_xxx` API key
  - Stores API key in Keychain via `CLIBridge`
  - Shows checkmark + "Signed in as {email}" + "Agent registered"
  - "Continue" button appears

### Step 3: Soulseek Credentials

- "Connect to Soulseek" heading
- Explanation: "djtoolkit uses Soulseek to find and download music. Enter your Soulseek account credentials."
- Username text field
- Password secure field
- Link: "Don't have an account? Create one at soulseek.org"
- "Continue" button (disabled until both fields filled)

### Step 4: AcoustID API Key

- "Audio Fingerprinting (Optional)" heading
- Explanation: "AcoustID identifies tracks by their audio fingerprint to prevent duplicates and match metadata. You can add this later."
- API key text field
- Link: "Get a free key at acoustid.org"
- "Skip" button (prominent) + "Continue" button

### Step 5: Confirm & Install

- "Ready to install" heading
- Summary card showing:
  - Account: {email}
  - Soulseek: {username}
  - AcoustID: configured / skipped
- **Advanced Settings** (collapsed `DisclosureGroup`):
  - Downloads directory: folder picker (default: `~/Music/djtoolkit/downloads`)
  - Poll interval: slider, 10-120 seconds (default: 30)
- "Install & Start Agent" button
- On click:
  1. Calls `CLIBridge` to run `djtoolkit agent configure` with collected credentials
  2. Calls `CLIBridge` to run `djtoolkit agent install`
  3. Shows progress with status messages

### Step 6: Done

- Large checkmark
- "djtoolkit is running" heading
- "Your music will download to: ~/Music/djtoolkit/downloads" (or custom path)
- "Agent logs: ~/Library/Logs/djtoolkit/agent.log"
- "Open djtoolkit" button → opens the web UI in default browser
- "Close" button

---

## CLIBridge

A Swift class that wraps `Process` to call the djtoolkit CLI binary. This ensures the Setup Assistant uses the exact same codepath as the terminal flow.

### Binary Resolution

Same logic as `launchd.py`:
1. Check `/opt/homebrew/bin/djtoolkit` (arm64 Homebrew)
2. Check `/usr/local/bin/djtoolkit` (x86_64 Homebrew or .pkg install)
3. Fall back to `which djtoolkit`
4. If bundled in DMG: use the binary from the same DMG volume

### Commands Called

```swift
// Step 2: Store API key after OAuth
CLIBridge.run(["agent", "configure-headless",
    "--api-key", apiKey,
    "--slsk-user", slskUsername,
    "--slsk-pass", slskPassword,
    "--acoustid-key", acoustidKey,   // omitted if skipped
    "--cloud-url", cloudURL,
    "--downloads-dir", downloadsDir, // omitted if default
    "--poll-interval", pollInterval  // omitted if default
])

// Step 5: Install LaunchAgent
CLIBridge.run(["agent", "install"])
```

### New CLI Command: `agent configure-headless`

The existing `agent configure` prompts interactively for credentials. The Setup Assistant needs a non-interactive variant that accepts all values as arguments.

```
djtoolkit agent configure-headless \
  --api-key djt_xxx \
  --slsk-user yenkz \
  --slsk-pass secret \
  [--acoustid-key xxx] \
  [--cloud-url https://api.djtoolkit.com] \
  [--downloads-dir ~/Music/djtoolkit/downloads] \
  [--poll-interval 30]
```

This command:
- Stores credentials in macOS Keychain (same as interactive `configure`)
- Writes `~/.djtoolkit/config.toml` with all settings
- Exits with code 0 on success, non-zero on failure
- Outputs JSON to stdout for the Setup Assistant to parse: `{"status": "ok"}` or `{"status": "error", "message": "..."}`

**Security note:** Passing the password via command-line argument is visible in `ps` output momentarily. Acceptable here because the Setup Assistant runs locally and the process is short-lived. Alternative: pass via stdin or environment variable if this is a concern.

---

## Distribution

### DMG Layout

The DMG disk image will contain:

```
djtoolkit-1.2.3/
├── DJToolkit Setup.app    ← SwiftUI wizard (user double-clicks this)
├── djtoolkit              ← CLI binary (installed by Setup.app or manually)
└── README.txt             ← Brief instructions
```

The Setup Assistant's first step will check if the CLI binary is installed. If not, it copies it to `/usr/local/bin/` (prompting for admin password via `AuthorizationExecuteWithPrivileges` or an embedded privileged helper).

### Homebrew Integration

After `brew install djtoolkit`:
- The CLI binary is installed to the Homebrew prefix
- The Setup Assistant app is installed to `<homebrew-prefix>/share/djtoolkit/DJToolkit Setup.app`
- A new CLI command `djtoolkit setup` opens the Setup Assistant:
  ```swift
  // Equivalent to:
  open "<homebrew-prefix>/share/djtoolkit/DJToolkit Setup.app"
  ```
- The Homebrew postinstall message tells users to run `djtoolkit setup`

### Homebrew Formula Changes

```ruby
def install
  bin.install "djtoolkit"
  (share/"djtoolkit").install "DJToolkit Setup.app"
end

def caveats
  <<~EOS
    Run the setup wizard to configure djtoolkit:
      djtoolkit setup

    Or open the app directly:
      open #{share}/djtoolkit/DJToolkit\\ Setup.app
  EOS
end
```

---

## Build & CI

### Xcode Project

```
setup-assistant/
├── DJToolkitSetup.xcodeproj
├── DJToolkitSetup/
│   ├── DJToolkitSetupApp.swift     # @main, URL scheme handler
│   ├── Views/
│   │   ├── WelcomeView.swift
│   │   ├── SignInView.swift
│   │   ├── SoulseekView.swift
│   │   ├── AcoustIDView.swift
│   │   ├── ConfirmView.swift
│   │   └── DoneView.swift
│   ├── Models/
│   │   └── SetupState.swift        # @Observable state object
│   ├── Services/
│   │   ├── CLIBridge.swift         # Process wrapper
│   │   ├── OAuthService.swift      # ASWebAuthenticationSession
│   │   └── AgentAPI.swift          # POST /agents/register via URLSession
│   ├── Info.plist                  # URL scheme registration
│   └── Assets.xcassets
└── DJToolkitSetupTests/
    └── CLIBridgeTests.swift
```

### CI Changes (release.yml)

Add a step after the PyInstaller build:

```yaml
- name: Build Setup Assistant
  run: |
    xcodebuild -project setup-assistant/DJToolkitSetup.xcodeproj \
      -scheme DJToolkitSetup \
      -configuration Release \
      -archivePath build/DJToolkitSetup.xcarchive \
      archive
    xcodebuild -exportArchive \
      -archivePath build/DJToolkitSetup.xcarchive \
      -exportOptionsPlist setup-assistant/ExportOptions.plist \
      -exportPath build/
    cp -R "build/DJToolkit Setup.app" dist/
```

The DMG build step in `build.sh` is updated to include the .app in the staging directory.

### Code Signing & Notarization

If an Apple Developer account is available:
- Sign both the CLI binary and the Setup Assistant app
- Notarize the DMG for Gatekeeper
- Without signing: users get the "unidentified developer" warning and must right-click → Open

---

## Supabase Auth Configuration

### Custom URL Scheme Redirect

Supabase Auth must be configured to allow the `djtoolkit://auth/callback` redirect URI:

1. In Supabase Dashboard → Authentication → URL Configuration
2. Add `djtoolkit://auth/callback` to the Redirect URLs allowlist

This is a one-time configuration change. No code changes needed on the backend.

### Auth Providers

The Setup Assistant opens the Supabase hosted auth page, which supports whatever providers are configured (Google, GitHub, email/password, etc.). The wizard is provider-agnostic — it just receives the JWT from the callback.

---

## Error Handling

| Scenario | Handling |
|---|---|
| OAuth cancelled by user | Return to Sign In step, "Sign-in was cancelled" message |
| OAuth token expired | Show error, prompt to sign in again |
| Agent registration fails (network) | Show retry button with error message |
| Agent registration fails (403/rate-limit) | Show specific error from API response |
| CLI binary not found | Prompt to install: "djtoolkit CLI not found. Install with: brew install djtoolkit" (DMG: offer to install from disk image) |
| `configure-headless` fails | Show error output from CLI, offer to retry or go back |
| `agent install` fails | Show error, offer to copy manual terminal commands |
| Keychain access denied | Prompt user to allow Keychain access |
| Already configured | Detect existing `~/.djtoolkit/config.toml`, offer to reconfigure or skip |

---

## Security Considerations

- **JWT lifetime**: The JWT from Supabase Auth has a short lifetime (default 1 hour). The Setup Assistant uses it immediately to register the agent, so expiration is not a concern.
- **API key display**: The API key is never displayed in the wizard. It goes straight from the API response to Keychain storage.
- **Password in `ps`**: The `configure-headless` command receives the Soulseek password as a CLI argument, which is briefly visible in `ps`. Mitigation: use `--stdin` mode where the Setup Assistant pipes credentials via stdin instead. If this is deemed unnecessary for a local-only tool, the CLI argument approach is simpler.
- **Custom URL scheme hijacking**: Another app could register the `djtoolkit://` scheme. Mitigation: validate the JWT's integrity (already done server-side during agent registration). The JWT is useless without the Supabase project's signing key.

---

## Scope

### In scope
- SwiftUI macOS app with 6-step wizard
- OAuth via `ASWebAuthenticationSession`
- Auto agent registration
- Credential collection (Soulseek, AcoustID)
- Advanced settings (downloads dir, poll interval)
- `configure-headless` CLI command
- DMG bundling
- Homebrew integration (`djtoolkit setup` command)
- CI build step for the .app

### Out of scope
- Windows/Linux GUI (terminal-only for now)
- Automatic updates for the Setup Assistant
- In-app agent status monitoring (use `djtoolkit agent status` or web UI)
- Changing credentials after initial setup (use `djtoolkit agent configure` in terminal)
