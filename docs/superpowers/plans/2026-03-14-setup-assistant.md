# Setup Assistant Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a native SwiftUI macOS Setup Assistant that replaces the terminal-based agent configuration flow with a guided wizard.

**Architecture:** Two deliverables — (1) a new `configure-headless` CLI command that accepts credentials via stdin JSON, and a `setup` CLI command that opens the Setup Assistant app; (2) a SwiftUI macOS app with a 6-step wizard (Welcome → Sign In → Soulseek → AcoustID → Confirm → Done) that calls the CLI under the hood. Distribution via DMG and Homebrew.

**Tech Stack:** Python/Typer (CLI), Swift/SwiftUI (macOS app), ASWebAuthenticationSession (OAuth), Xcode (build), GitHub Actions (CI)

---

## Chunk 1: CLI Foundation (`configure-headless` + `setup` commands)

### Task 1: Add `configure-headless` command — test

**Files:**
- Create: `tests/test_configure_headless.py`

- [ ] **Step 1: Write the failing test for configure-headless with valid JSON**

```python
"""Tests for djtoolkit agent configure-headless command."""

import json
import subprocess
import sys
from unittest.mock import patch, MagicMock

import pytest
from typer.testing import CliRunner

from djtoolkit.__main__ import app


runner = CliRunner()


def _make_input(*, api_key="djt_abc123def456abc123def456abc123def456abc1",
                slsk_user="testuser", slsk_pass="testpass",
                acoustid_key=None, cloud_url="https://api.djtoolkit.com",
                downloads_dir="~/Music/djtoolkit/downloads",
                poll_interval=30):
    return json.dumps({
        "api_key": api_key,
        "slsk_user": slsk_user,
        "slsk_pass": slsk_pass,
        "acoustid_key": acoustid_key,
        "cloud_url": cloud_url,
        "downloads_dir": downloads_dir,
        "poll_interval": poll_interval,
    })


@patch("djtoolkit.agent.keychain.store_agent_credentials")
def test_configure_headless_valid_json(mock_store, tmp_path, monkeypatch):
    """Valid JSON via stdin → stores credentials + writes config."""
    monkeypatch.setenv("HOME", str(tmp_path))
    input_json = _make_input()

    result = runner.invoke(app, ["agent", "configure-headless", "--stdin"],
                           input=input_json)

    assert result.exit_code == 0
    output = json.loads(result.stdout)
    assert output["status"] == "ok"
    assert "config_path" in output
    assert "downloads_dir" in output

    mock_store.assert_called_once_with(
        api_key="djt_abc123def456abc123def456abc123def456abc1",
        slsk_username="testuser",
        slsk_password="testpass",
        acoustid_key=None,
    )

    config_path = tmp_path / ".djtoolkit" / "config.toml"
    assert config_path.exists()
    content = config_path.read_text()
    assert 'cloud_url = "https://api.djtoolkit.com"' in content
    assert "poll_interval_sec = 30" in content


@patch("djtoolkit.agent.keychain.store_agent_credentials")
def test_configure_headless_custom_settings(mock_store, tmp_path, monkeypatch):
    """Custom downloads_dir and poll_interval are written to config."""
    monkeypatch.setenv("HOME", str(tmp_path))
    input_json = _make_input(
        downloads_dir="/Users/test/MyMusic",
        poll_interval=60,
    )

    result = runner.invoke(app, ["agent", "configure-headless", "--stdin"],
                           input=input_json)

    assert result.exit_code == 0
    config_path = tmp_path / ".djtoolkit" / "config.toml"
    content = config_path.read_text()
    assert 'downloads_dir = "/Users/test/MyMusic"' in content
    assert "poll_interval_sec = 60" in content


def test_configure_headless_malformed_json():
    """Malformed JSON → error with exit code 1."""
    result = runner.invoke(app, ["agent", "configure-headless", "--stdin"],
                           input="not valid json{{{")

    assert result.exit_code == 1
    output = json.loads(result.stdout)
    assert output["status"] == "error"
    assert "Invalid input" in output["message"]


def test_configure_headless_missing_required_field():
    """Missing required field → error."""
    input_json = json.dumps({"api_key": "djt_xxx", "slsk_user": "user"})
    # missing slsk_pass

    result = runner.invoke(app, ["agent", "configure-headless", "--stdin"],
                           input=input_json)

    assert result.exit_code == 1
    output = json.loads(result.stdout)
    assert output["status"] == "error"
    assert "slsk_pass" in output["message"]


def test_configure_headless_bad_api_key_prefix():
    """API key without djt_ prefix → error."""
    input_json = _make_input(api_key="bad_key_no_prefix")

    result = runner.invoke(app, ["agent", "configure-headless", "--stdin"],
                           input=input_json)

    assert result.exit_code == 1
    output = json.loads(result.stdout)
    assert output["status"] == "error"
    assert "djt_" in output["message"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `poetry run pytest tests/test_configure_headless.py -v`
Expected: FAIL — `configure-headless` command doesn't exist yet

- [ ] **Step 3: Commit test file**

```bash
git add tests/test_configure_headless.py
git commit -m "test: add tests for agent configure-headless command"
```

---

### Task 2: Implement `configure-headless` command

**Files:**
- Modify: `djtoolkit/__main__.py` (add new command after existing `configure` at ~line 515)

- [ ] **Step 1: Add the configure-headless command**

Add after the existing `agent_configure` function in `djtoolkit/__main__.py`:

```python
@agent_app.command("configure-headless")
def agent_configure_headless(
    stdin: Annotated[bool, typer.Option("--stdin", help="Read JSON config from stdin")] = False,
):
    """Non-interactive agent configuration — reads credentials from stdin JSON.

    Used by the Setup Assistant GUI. Outputs JSON to stdout.
    """
    import json as _json
    import sys as _sys
    from djtoolkit.agent.keychain import store_agent_credentials

    if not stdin:
        _sys.stdout.write(_json.dumps({
            "status": "error",
            "message": "Use --stdin to pipe JSON credentials via stdin",
        }) + "\n")
        raise typer.Exit(1)

    raw = _sys.stdin.read()

    try:
        data = _json.loads(raw)
    except _json.JSONDecodeError as e:
        _sys.stdout.write(_json.dumps({
            "status": "error",
            "message": f"Invalid input: malformed JSON — {e}",
        }) + "\n")
        raise typer.Exit(1)

    # Validate required fields
    required = ["api_key", "slsk_user", "slsk_pass"]
    for field in required:
        if field not in data or not data[field]:
            _sys.stdout.write(_json.dumps({
                "status": "error",
                "message": f"Invalid input: missing required field '{field}'",
            }) + "\n")
            raise typer.Exit(1)

    api_key = data["api_key"]
    if not api_key.startswith("djt_"):
        _sys.stdout.write(_json.dumps({
            "status": "error",
            "message": "Invalid input: api_key must start with 'djt_'",
        }) + "\n")
        raise typer.Exit(1)

    # Store credentials in Keychain
    store_agent_credentials(
        api_key=api_key,
        slsk_username=data["slsk_user"],
        slsk_password=data["slsk_pass"],
        acoustid_key=data.get("acoustid_key"),
    )

    # Write config file
    cloud_url = data.get("cloud_url", "https://api.djtoolkit.com")
    downloads_dir = data.get("downloads_dir", "~/Music/djtoolkit/downloads")
    poll_interval = data.get("poll_interval", 30)

    # Expand ~ for the response but keep unexpanded in config if user passed ~
    expanded_downloads = str(Path(downloads_dir).expanduser())

    config_dir = Path.home() / ".djtoolkit"
    config_dir.mkdir(parents=True, exist_ok=True)
    config_path = config_dir / "config.toml"

    config_content = f"""[agent]
cloud_url = "{cloud_url}"
poll_interval_sec = {poll_interval}
max_concurrent_jobs = 2
downloads_dir = "{downloads_dir}"

[soulseek]
search_timeout_sec = 15
download_timeout_sec = 300

[fingerprint]
enabled = true

[cover_art]
sources = "coverart itunes deezer"
"""
    config_path.write_text(config_content)

    _sys.stdout.write(_json.dumps({
        "status": "ok",
        "config_path": str(config_path),
        "downloads_dir": expanded_downloads,
    }) + "\n")
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `poetry run pytest tests/test_configure_headless.py -v`
Expected: All 5 tests PASS

- [ ] **Step 3: Commit**

```bash
git add djtoolkit/__main__.py
git commit -m "feat: add agent configure-headless command for GUI setup"
```

---

### Task 3: Add `djtoolkit setup` command

**Files:**
- Modify: `djtoolkit/__main__.py` (add top-level `setup` command)

- [ ] **Step 1: Add the setup command**

Add after the agent commands section in `djtoolkit/__main__.py`:

```python
@app.command("setup")
def setup_wizard():
    """Open the Setup Assistant GUI."""
    import platform
    import subprocess
    import shutil

    if platform.system() != "Darwin":
        console.print("[red]The Setup Assistant is only available on macOS.[/red]")
        console.print("Use [bold]djtoolkit agent configure --api-key djt_xxx[/bold] instead.")
        raise typer.Exit(1)

    # Search for the Setup Assistant app
    search_paths = [
        # Homebrew arm64
        Path("/opt/homebrew/share/djtoolkit/DJToolkit Setup.app"),
        # Homebrew x86_64
        Path("/usr/local/share/djtoolkit/DJToolkit Setup.app"),
        # Same directory as binary (DMG or dev)
        Path(__file__).parent.parent / "DJToolkit Setup.app",
    ]

    app_path = None
    for p in search_paths:
        if p.exists():
            app_path = p
            break

    if app_path is None:
        console.print("[red]Setup Assistant not found.[/red]")
        console.print("Use [bold]djtoolkit agent configure --api-key djt_xxx[/bold] for terminal setup.")
        raise typer.Exit(1)

    console.print(f"Opening Setup Assistant...")
    subprocess.run(["open", str(app_path)])
```

- [ ] **Step 2: Smoke test the command**

Run: `poetry run djtoolkit setup`
Expected: "Setup Assistant not found" error (since the .app doesn't exist yet). Verifies the command is registered and runs.

- [ ] **Step 3: Commit**

```bash
git add djtoolkit/__main__.py
git commit -m "feat: add 'djtoolkit setup' command to open Setup Assistant"
```

---

## Chunk 2: SwiftUI App — Project Scaffolding + Services

### Task 4: Create Xcode project structure

**Files:**
- Create: `setup-assistant/DJToolkitSetup/DJToolkitSetupApp.swift`
- Create: `setup-assistant/DJToolkitSetup/Models/SetupState.swift`
- Create: `setup-assistant/DJToolkitSetup/Info.plist`
- Create: `setup-assistant/ExportOptions.plist`

- [ ] **Step 1: Create directory structure**

```bash
mkdir -p setup-assistant/DJToolkitSetup/{Views,Models,Services}
mkdir -p setup-assistant/DJToolkitSetup/Assets.xcassets
mkdir -p setup-assistant/DJToolkitSetupTests
```

- [ ] **Step 2: Create the SwiftUI app entry point**

Write `setup-assistant/DJToolkitSetup/DJToolkitSetupApp.swift`:

```swift
import SwiftUI

@main
struct DJToolkitSetupApp: App {
    @State private var state = SetupState()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(state)
                .frame(width: 520, height: 480)
                .fixedSize()
                .task {
                    // Install CLI binary from DMG if not already installed
                    if CLIBridge.findBinary() == nil {
                        do {
                            _ = try CLIBridge.installBinaryFromDMG()
                        } catch {
                            state.errorMessage = error.localizedDescription
                        }
                    }
                }
        }
        .windowResizability(.contentSize)
    }
}

struct ContentView: View {
    @Environment(SetupState.self) private var state

    var body: some View {
        Group {
            switch state.currentStep {
            case .welcome:
                WelcomeView()
            case .signIn:
                SignInView()
            case .soulseek:
                SoulseekView()
            case .acoustID:
                AcoustIDView()
            case .confirm:
                ConfirmView()
            case .done:
                DoneView()
            }
        }
        .animation(.easeInOut(duration: 0.2), value: state.currentStep)
    }
}
```

- [ ] **Step 3: Create the SetupState model**

Write `setup-assistant/DJToolkitSetup/Models/SetupState.swift`:

```swift
import Foundation
import Observation
import Network

enum SetupStep: Int, CaseIterable {
    case welcome, signIn, soulseek, acoustID, confirm, done
}

@Observable
class SetupState {
    // Navigation
    var currentStep: SetupStep = .welcome

    // Step 2: Sign In
    var jwt: String = ""
    var apiKey: String = ""
    var userEmail: String = ""

    // Step 3: Soulseek
    var slskUsername: String = ""
    var slskPassword: String = ""

    // Step 4: AcoustID
    var acoustidKey: String = ""

    // Step 5: Advanced Settings
    var downloadsDir: String = "~/Music/djtoolkit/downloads"
    var pollInterval: Int = 30
    var cloudURL: String = "https://api.djtoolkit.com"

    // Supabase URL for OAuth — derived from env or config, NOT hardcoded
    // Set via SUPABASE_URL environment variable or build-time config
    var supabaseURL: String = ProcessInfo.processInfo.environment["SUPABASE_URL"]
        ?? "https://CONFIGURE_ME.supabase.co"

    // Status
    var isLoading: Bool = false
    var errorMessage: String? = nil
    var isOnline: Bool = true

    // Pre-existing state detection
    var alreadyConfigured: Bool = false
    var agentRunning: Bool = false

    // Result (from configure-headless output)
    var resolvedDownloadsDir: String = ""

    // Network monitoring
    private let monitor = NWPathMonitor()

    init() {
        monitor.pathUpdateHandler = { [weak self] path in
            Task { @MainActor in
                self?.isOnline = path.status == .satisfied
            }
        }
        monitor.start(queue: DispatchQueue(label: "NetworkMonitor"))

        // Detect pre-existing configuration
        let configPath = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".djtoolkit/config.toml")
        alreadyConfigured = FileManager.default.fileExists(atPath: configPath.path)

        // Check if agent is already running via launchctl
        let process = Process()
        let pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = ["list", "com.djtoolkit.agent"]
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        try? process.run()
        process.waitUntilExit()
        agentRunning = process.terminationStatus == 0
    }

    func advance() {
        guard let nextIndex = SetupStep(rawValue: currentStep.rawValue + 1) else { return }
        currentStep = nextIndex
    }

    func goBack() {
        guard let prevIndex = SetupStep(rawValue: currentStep.rawValue - 1) else { return }
        currentStep = prevIndex
    }
}
```

- [ ] **Step 4: Create Info.plist**

Write `setup-assistant/DJToolkitSetup/Info.plist`:

Note: No `CFBundleURLTypes` needed — `ASWebAuthenticationSession` handles the OAuth callback entirely via its `callbackURLScheme` parameter, without requiring a registered URL scheme.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>LSMinimumSystemVersion</key>
    <string>14.0</string>
</dict>
</plist>
```

- [ ] **Step 5: Create ExportOptions.plist**

Write `setup-assistant/ExportOptions.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key>
    <string>mac-application</string>
    <key>destination</key>
    <string>export</string>
</dict>
</plist>
```

- [ ] **Step 6: Commit scaffolding**

```bash
git add setup-assistant/
git commit -m "feat: scaffold SwiftUI Setup Assistant project"
```

---

### Task 5: Implement CLIBridge service

**Files:**
- Create: `setup-assistant/DJToolkitSetup/Services/CLIBridge.swift`

- [ ] **Step 1: Write CLIBridge**

```swift
import Foundation

enum CLIBridgeError: LocalizedError {
    case binaryNotFound
    case executionFailed(String)
    case invalidOutput(String)

    var errorDescription: String? {
        switch self {
        case .binaryNotFound:
            return "djtoolkit CLI not found. Install with: brew install djtoolkit"
        case .executionFailed(let msg):
            return "CLI command failed: \(msg)"
        case .invalidOutput(let msg):
            return "Unexpected CLI output: \(msg)"
        }
    }
}

struct CLIResult: Decodable {
    let status: String
    let message: String?
    let config_path: String?
    let downloads_dir: String?
}

enum CLIBridge {
    /// Locate the djtoolkit binary on disk.
    static func findBinary() -> URL? {
        let candidates = [
            "/opt/homebrew/bin/djtoolkit",
            "/usr/local/bin/djtoolkit",
        ]
        for path in candidates {
            if FileManager.default.isExecutableFile(atPath: path) {
                return URL(fileURLWithPath: path)
            }
        }
        // Fallback: which djtoolkit
        let whichProcess = Process()
        let whichPipe = Pipe()
        whichProcess.executableURL = URL(fileURLWithPath: "/usr/bin/which")
        whichProcess.arguments = ["djtoolkit"]
        whichProcess.standardOutput = whichPipe
        whichProcess.standardError = FileHandle.nullDevice
        try? whichProcess.run()
        whichProcess.waitUntilExit()
        if whichProcess.terminationStatus == 0 {
            let data = whichPipe.fileHandleForReading.readDataToEndOfFile()
            let path = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
            if let path, !path.isEmpty {
                return URL(fileURLWithPath: path)
            }
        }
        return nil
    }

    /// Run a CLI command with optional stdin data. Returns stdout.
    static func run(_ arguments: [String], stdin: String? = nil) async throws -> String {
        guard let binary = findBinary() else {
            throw CLIBridgeError.binaryNotFound
        }

        let process = Process()
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()

        process.executableURL = binary
        process.arguments = arguments
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        if let stdin {
            let stdinPipe = Pipe()
            process.standardInput = stdinPipe
            let inputData = Data(stdin.utf8)
            stdinPipe.fileHandleForWriting.write(inputData)
            stdinPipe.fileHandleForWriting.closeFile()
        }

        try process.run()
        process.waitUntilExit()

        let stdoutData = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
        let stderrData = stderrPipe.fileHandleForReading.readDataToEndOfFile()
        let stdout = String(data: stdoutData, encoding: .utf8) ?? ""
        let stderr = String(data: stderrData, encoding: .utf8) ?? ""

        if process.terminationStatus != 0 {
            // Try to parse JSON error from stdout first
            if let data = stdout.data(using: .utf8),
               let result = try? JSONDecoder().decode(CLIResult.self, from: data) {
                throw CLIBridgeError.executionFailed(result.message ?? "Unknown error")
            }
            throw CLIBridgeError.executionFailed(stderr.isEmpty ? stdout : stderr)
        }

        return stdout
    }

    /// Run configure-headless with credentials piped via stdin.
    static func configureHeadless(
        apiKey: String,
        slskUser: String,
        slskPass: String,
        acoustidKey: String?,
        cloudURL: String,
        downloadsDir: String,
        pollInterval: Int
    ) async throws -> CLIResult {
        var payload: [String: Any] = [
            "api_key": apiKey,
            "slsk_user": slskUser,
            "slsk_pass": slskPass,
            "cloud_url": cloudURL,
            "downloads_dir": downloadsDir,
            "poll_interval": pollInterval,
        ]
        if let acoustidKey, !acoustidKey.isEmpty {
            payload["acoustid_key"] = acoustidKey
        } else {
            payload["acoustid_key"] = NSNull()
        }

        let jsonData = try JSONSerialization.data(withJSONObject: payload)
        let jsonString = String(data: jsonData, encoding: .utf8)!

        let stdout = try await run(
            ["agent", "configure-headless", "--stdin"],
            stdin: jsonString
        )

        guard let data = stdout.data(using: .utf8),
              let result = try? JSONDecoder().decode(CLIResult.self, from: data) else {
            throw CLIBridgeError.invalidOutput(stdout)
        }

        return result
    }

    /// Run agent install.
    static func installAgent() async throws {
        _ = try await run(["agent", "install"])
    }

    /// Install CLI binary from DMG to /usr/local/bin (prompts for admin password).
    /// Returns true if installed, false if already exists or user cancelled.
    static func installBinaryFromDMG() throws -> Bool {
        // Already installed?
        if findBinary() != nil { return true }

        // Look for binary on the same DMG volume as this app
        let appBundle = Bundle.main.bundlePath
        let dmgVolume = (appBundle as NSString).deletingLastPathComponent
        let dmgBinary = (dmgVolume as NSString).appendingPathComponent("djtoolkit")

        guard FileManager.default.fileExists(atPath: dmgBinary) else {
            throw CLIBridgeError.binaryNotFound
        }

        var error: NSDictionary?
        let script = "do shell script \"cp '\(dmgBinary)' /usr/local/bin/djtoolkit && chmod +x /usr/local/bin/djtoolkit\" with administrator privileges"
        guard let appleScript = NSAppleScript(source: script) else {
            throw CLIBridgeError.executionFailed("Failed to create install script")
        }
        appleScript.executeAndReturnError(&error)
        if let error {
            let msg = error[NSAppleScript.errorMessage] as? String ?? "User cancelled"
            throw CLIBridgeError.executionFailed(msg)
        }
        return true
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add setup-assistant/DJToolkitSetup/Services/CLIBridge.swift
git commit -m "feat: add CLIBridge service for Process-based CLI calls"
```

---

### Task 6: Implement OAuthService and AgentAPI

**Files:**
- Create: `setup-assistant/DJToolkitSetup/Services/OAuthService.swift`
- Create: `setup-assistant/DJToolkitSetup/Services/AgentAPI.swift`

- [ ] **Step 1: Write OAuthService**

```swift
import AuthenticationServices
import Foundation

class OAuthService: NSObject, ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        NSApp.keyWindow ?? ASPresentationAnchor()
    }

    /// Start OAuth flow. Returns the access token (JWT) from the callback URL.
    func signIn(supabaseURL: String) async throws -> (jwt: String, email: String?) {
        let authURL = URL(string: "\(supabaseURL)/auth/v1/authorize?provider=google&redirect_to=djtoolkit://auth/callback")!
        let callbackScheme = "djtoolkit"

        return try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(
                url: authURL,
                callbackURLScheme: callbackScheme
            ) { callbackURL, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                guard let callbackURL else {
                    continuation.resume(throwing: OAuthError.noCallback)
                    return
                }

                // Supabase returns tokens in the fragment: #access_token=...&token_type=bearer&...
                guard let fragment = callbackURL.fragment else {
                    continuation.resume(throwing: OAuthError.missingToken)
                    return
                }

                let params = fragment
                    .split(separator: "&")
                    .reduce(into: [String: String]()) { dict, pair in
                        let parts = pair.split(separator: "=", maxSplits: 1)
                        if parts.count == 2 {
                            dict[String(parts[0])] = String(parts[1])
                        }
                    }

                guard let accessToken = params["access_token"] else {
                    continuation.resume(throwing: OAuthError.missingToken)
                    return
                }

                // Decode email from JWT payload (base64url-encoded middle segment)
                let email = Self.extractEmail(from: accessToken)

                continuation.resume(returning: (jwt: accessToken, email: email))
            }

            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            session.start()
        }
    }

    /// Extract email from JWT payload without verification (display only).
    private static func extractEmail(from jwt: String) -> String? {
        let segments = jwt.split(separator: ".")
        guard segments.count == 3 else { return nil }
        var base64 = String(segments[1])
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while base64.count % 4 != 0 { base64.append("=") }
        guard let data = Data(base64Encoded: base64),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        return json["email"] as? String
    }
}

enum OAuthError: LocalizedError {
    case noCallback
    case missingToken

    var errorDescription: String? {
        switch self {
        case .noCallback: return "Sign-in was cancelled."
        case .missingToken: return "No access token received. Please try again."
        }
    }
}
```

- [ ] **Step 2: Write AgentAPI**

```swift
import Foundation

enum AgentAPIError: LocalizedError {
    case registrationFailed(String)
    case networkError(String)

    var errorDescription: String? {
        switch self {
        case .registrationFailed(let msg): return "Agent registration failed: \(msg)"
        case .networkError(let msg): return "Network error: \(msg)"
        }
    }
}

struct AgentRegisterResponse: Decodable {
    let agent_id: String
    let api_key: String
    let message: String?
}

struct AgentAPI {
    let cloudURL: String

    /// Register a new agent using the JWT from OAuth.
    func registerAgent(jwt: String, machineName: String) async throws -> AgentRegisterResponse {
        guard let url = URL(string: "\(cloudURL)/api/agents/register") else {
            throw AgentAPIError.networkError("Invalid cloud URL")
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(jwt)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let body = ["machine_name": machineName]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw AgentAPIError.networkError("Invalid response")
        }

        switch httpResponse.statusCode {
        case 201:
            return try JSONDecoder().decode(AgentRegisterResponse.self, from: data)
        case 401:
            throw AgentAPIError.registrationFailed("Authentication expired. Please sign in again.")
        case 429:
            throw AgentAPIError.registrationFailed("Too many registration attempts. Please wait and try again.")
        default:
            let body = String(data: data, encoding: .utf8) ?? "Unknown error"
            throw AgentAPIError.registrationFailed("Server returned \(httpResponse.statusCode): \(body)")
        }
    }
}
```

- [ ] **Step 3: Commit**

```bash
git add setup-assistant/DJToolkitSetup/Services/
git commit -m "feat: add OAuthService and AgentAPI for sign-in flow"
```

---

## Chunk 3: SwiftUI Views

### Task 7: WelcomeView and SignInView

**Files:**
- Create: `setup-assistant/DJToolkitSetup/Views/WelcomeView.swift`
- Create: `setup-assistant/DJToolkitSetup/Views/SignInView.swift`

- [ ] **Step 1: Write WelcomeView**

```swift
import SwiftUI

struct WelcomeView: View {
    @Environment(SetupState.self) private var state

    var body: some View {
        VStack(spacing: 24) {
            Spacer()

            Image(systemName: "music.note.house.fill")
                .font(.system(size: 64))
                .foregroundStyle(.accent)

            Text("Set up djtoolkit on this Mac")
                .font(.title)
                .fontWeight(.semibold)

            Text("djtoolkit downloads, fingerprints, and tags your DJ music library. This wizard will connect your Mac to your djtoolkit account.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 360)

            // Pre-existing state warnings
            if state.agentRunning {
                GroupBox {
                    Label("djtoolkit agent is already running on this Mac.", systemImage: "checkmark.circle")
                        .foregroundStyle(.green)
                    Text("You can reconfigure it or close this wizard.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: 360)
            } else if state.alreadyConfigured {
                GroupBox {
                    Label("A previous configuration was found.", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                    Text("Continuing will overwrite the existing configuration.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: 360)
            }

            Spacer()

            HStack {
                if state.agentRunning {
                    Button("Close") { NSApp.terminate(nil) }
                        .buttonStyle(.bordered)
                    Spacer()
                }
                Button(state.agentRunning ? "Reconfigure" : "Get Started") {
                    state.advance()
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
            }

            Spacer().frame(height: 20)
        }
        .padding(40)
    }
}
```

- [ ] **Step 2: Write SignInView**

```swift
import SwiftUI

struct SignInView: View {
    @Environment(SetupState.self) private var state
    @State private var oauthService = OAuthService()
    @State private var isSigningIn = false
    @State private var signedIn = false

    var body: some View {
        VStack(spacing: 24) {
            Spacer()

            Text("Sign in to your djtoolkit account")
                .font(.title2)
                .fontWeight(.semibold)

            if !state.isOnline {
                Label("No internet connection. Connect to the internet and try again.",
                      systemImage: "wifi.slash")
                    .foregroundStyle(.red)
                    .font(.callout)
            }

            if signedIn {
                VStack(spacing: 8) {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 40))
                        .foregroundStyle(.green)
                    Text("Signed in as \(state.userEmail)")
                        .font(.headline)
                    Text("Agent registered")
                        .foregroundStyle(.secondary)
                }
            } else if isSigningIn {
                ProgressView("Waiting for sign-in...")
            } else {
                Button("Sign In with Browser") {
                    Task { await performSignIn() }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(!state.isOnline)
            }

            if let error = state.errorMessage {
                Text(error)
                    .foregroundStyle(.red)
                    .font(.callout)

                Button("Try Again") {
                    state.errorMessage = nil
                }
                .buttonStyle(.bordered)
            }

            Spacer()

            HStack {
                Button("Back") { state.goBack() }
                    .buttonStyle(.bordered)
                Spacer()
                Button("Continue") { state.advance() }
                    .buttonStyle(.borderedProminent)
                    .disabled(!signedIn)
            }
        }
        .padding(40)
    }

    private func performSignIn() async {
        isSigningIn = true
        state.errorMessage = nil

        do {
            // 1. OAuth — supabaseURL comes from SUPABASE_URL env var (set at build time)
            let (jwt, email) = try await oauthService.signIn(
                supabaseURL: state.supabaseURL
            )
            state.jwt = jwt
            state.userEmail = email ?? "unknown"

            // 2. Register agent
            let api = AgentAPI(cloudURL: state.cloudURL)
            let machineName = Host.current().localizedName ?? "My Mac"
            let response = try await api.registerAgent(jwt: jwt, machineName: machineName)
            state.apiKey = response.api_key

            signedIn = true
        } catch {
            state.errorMessage = error.localizedDescription
        }

        isSigningIn = false
    }
}
```

- [ ] **Step 3: Commit**

```bash
git add setup-assistant/DJToolkitSetup/Views/WelcomeView.swift
git add setup-assistant/DJToolkitSetup/Views/SignInView.swift
git commit -m "feat: add WelcomeView and SignInView"
```

---

### Task 8: SoulseekView and AcoustIDView

**Files:**
- Create: `setup-assistant/DJToolkitSetup/Views/SoulseekView.swift`
- Create: `setup-assistant/DJToolkitSetup/Views/AcoustIDView.swift`

- [ ] **Step 1: Write SoulseekView**

```swift
import SwiftUI

struct SoulseekView: View {
    @Environment(SetupState.self) private var state

    var body: some View {
        @Bindable var state = state

        VStack(spacing: 24) {
            Spacer()

            Image(systemName: "network")
                .font(.system(size: 40))
                .foregroundStyle(.accent)

            Text("Connect to Soulseek")
                .font(.title2)
                .fontWeight(.semibold)

            Text("djtoolkit uses Soulseek to find and download music. Enter your Soulseek account credentials.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 360)

            VStack(alignment: .leading, spacing: 12) {
                TextField("Username", text: $state.slskUsername)
                    .textFieldStyle(.roundedBorder)
                SecureField("Password", text: $state.slskPassword)
                    .textFieldStyle(.roundedBorder)
            }
            .frame(maxWidth: 300)

            Link("Don't have an account? Create one at soulseek.org",
                 destination: URL(string: "https://www.slsknet.org/news/node/1")!)
                .font(.callout)

            Spacer()

            HStack {
                Button("Back") { state.goBack() }
                    .buttonStyle(.bordered)
                Spacer()
                Button("Continue") { state.advance() }
                    .buttonStyle(.borderedProminent)
                    .disabled(state.slskUsername.isEmpty || state.slskPassword.isEmpty)
            }
        }
        .padding(40)
    }
}
```

- [ ] **Step 2: Write AcoustIDView**

```swift
import SwiftUI

struct AcoustIDView: View {
    @Environment(SetupState.self) private var state

    var body: some View {
        @Bindable var state = state

        VStack(spacing: 24) {
            Spacer()

            Image(systemName: "waveform.badge.magnifyingglass")
                .font(.system(size: 40))
                .foregroundStyle(.accent)

            Text("Audio Fingerprinting (Optional)")
                .font(.title2)
                .fontWeight(.semibold)

            Text("AcoustID identifies tracks by their audio fingerprint to prevent duplicates and match metadata. You can add this later.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 360)

            TextField("AcoustID API Key", text: $state.acoustidKey)
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: 300)

            Link("Get a free key at acoustid.org",
                 destination: URL(string: "https://acoustid.org/api-key")!)
                .font(.callout)

            Spacer()

            HStack {
                Button("Back") { state.goBack() }
                    .buttonStyle(.bordered)
                Spacer()
                Button("Skip") { state.advance() }
                    .buttonStyle(.bordered)
                Button("Continue") { state.advance() }
                    .buttonStyle(.borderedProminent)
                    .disabled(state.acoustidKey.isEmpty)
            }
        }
        .padding(40)
    }
}
```

- [ ] **Step 3: Commit**

```bash
git add setup-assistant/DJToolkitSetup/Views/SoulseekView.swift
git add setup-assistant/DJToolkitSetup/Views/AcoustIDView.swift
git commit -m "feat: add SoulseekView and AcoustIDView"
```

---

### Task 9: ConfirmView and DoneView

**Files:**
- Create: `setup-assistant/DJToolkitSetup/Views/ConfirmView.swift`
- Create: `setup-assistant/DJToolkitSetup/Views/DoneView.swift`

- [ ] **Step 1: Write ConfirmView**

```swift
import SwiftUI

struct ConfirmView: View {
    @Environment(SetupState.self) private var state
    @State private var showAdvanced = false
    @State private var isInstalling = false
    @State private var installProgress: String = ""

    var body: some View {
        @Bindable var state = state

        VStack(spacing: 20) {
            Text("Ready to install")
                .font(.title2)
                .fontWeight(.semibold)

            // Summary card
            GroupBox {
                VStack(alignment: .leading, spacing: 8) {
                    LabeledContent("Account", value: state.userEmail)
                    LabeledContent("Soulseek", value: state.slskUsername)
                    LabeledContent("AcoustID", value: state.acoustidKey.isEmpty ? "Skipped" : "Configured")
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxWidth: 360)

            // Advanced settings
            DisclosureGroup("Advanced Settings", isExpanded: $showAdvanced) {
                VStack(alignment: .leading, spacing: 12) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Downloads directory")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                        HStack {
                            TextField("Path", text: $state.downloadsDir)
                                .textFieldStyle(.roundedBorder)
                            Button("Browse...") {
                                let panel = NSOpenPanel()
                                panel.canChooseDirectories = true
                                panel.canChooseFiles = false
                                panel.canCreateDirectories = true
                                if panel.runModal() == .OK, let url = panel.url {
                                    state.downloadsDir = url.path
                                }
                            }
                        }
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Poll interval: \(state.pollInterval) seconds")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                        Slider(value: Binding(
                            get: { Double(state.pollInterval) },
                            set: { state.pollInterval = Int($0) }
                        ), in: 10...120, step: 5)
                    }
                }
                .padding(.top, 8)
            }
            .frame(maxWidth: 360)

            if isInstalling {
                VStack(spacing: 8) {
                    ProgressView()
                    Text(installProgress)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            }

            if let error = state.errorMessage {
                Text(error)
                    .foregroundStyle(.red)
                    .font(.callout)
                    .frame(maxWidth: 360)
            }

            Spacer()

            HStack {
                Button("Back") { state.goBack() }
                    .buttonStyle(.bordered)
                    .disabled(isInstalling)
                Spacer()
                Button("Install & Start Agent") {
                    Task { await performInstall() }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(isInstalling)
            }
        }
        .padding(40)
    }

    private func performInstall() async {
        isInstalling = true
        state.errorMessage = nil

        do {
            // 1. Configure
            installProgress = "Storing credentials..."
            let result = try await CLIBridge.configureHeadless(
                apiKey: state.apiKey,
                slskUser: state.slskUsername,
                slskPass: state.slskPassword,
                acoustidKey: state.acoustidKey.isEmpty ? nil : state.acoustidKey,
                cloudURL: state.cloudURL,
                downloadsDir: state.downloadsDir,
                pollInterval: state.pollInterval
            )
            state.resolvedDownloadsDir = result.downloads_dir ?? state.downloadsDir

            // 2. Install
            installProgress = "Installing agent..."
            try await CLIBridge.installAgent()

            state.advance()
        } catch {
            state.errorMessage = error.localizedDescription
        }

        isInstalling = false
    }
}
```

- [ ] **Step 2: Write DoneView**

```swift
import SwiftUI

struct DoneView: View {
    @Environment(SetupState.self) private var state

    var body: some View {
        VStack(spacing: 24) {
            Spacer()

            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 64))
                .foregroundStyle(.green)

            Text("djtoolkit is running")
                .font(.title)
                .fontWeight(.semibold)

            VStack(alignment: .leading, spacing: 8) {
                Label {
                    Text("Your music will download to:")
                        .foregroundStyle(.secondary)
                } icon: {
                    Image(systemName: "folder.fill")
                }
                Text(state.resolvedDownloadsDir)
                    .font(.system(.body, design: .monospaced))
                    .padding(.leading, 28)

                Label {
                    Text("Agent logs:")
                        .foregroundStyle(.secondary)
                } icon: {
                    Image(systemName: "doc.text.fill")
                }
                Text("~/Library/Logs/djtoolkit/agent.log")
                    .font(.system(.body, design: .monospaced))
                    .padding(.leading, 28)
            }
            .frame(maxWidth: 360, alignment: .leading)

            Spacer()

            HStack {
                Button("Open djtoolkit") {
                    if let url = URL(string: state.cloudURL) {
                        NSWorkspace.shared.open(url)
                    }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)

                Button("Close") {
                    NSApp.terminate(nil)
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
            }

            Spacer().frame(height: 20)
        }
        .padding(40)
    }
}
```

- [ ] **Step 3: Commit**

```bash
git add setup-assistant/DJToolkitSetup/Views/ConfirmView.swift
git add setup-assistant/DJToolkitSetup/Views/DoneView.swift
git commit -m "feat: add ConfirmView and DoneView"
```

---

## Chunk 4: Xcode Project, CI, and Distribution

### Task 10: Create Xcode project file

**Files:**
- Create: `setup-assistant/DJToolkitSetup.xcodeproj/project.pbxproj`

This task requires Xcode. The Xcode project file is generated by Xcode itself and is not practical to hand-write.

- [ ] **Step 1: Generate Xcode project**

Open Xcode and create a new macOS App project:
1. File → New → Project → macOS → App
2. Product Name: `DJToolkitSetup`
3. Organization Identifier: `com.djtoolkit`
4. Interface: SwiftUI
5. Language: Swift
6. Save to: `setup-assistant/` directory
7. Set deployment target to macOS 14.0

- [ ] **Step 2: Add existing source files to the Xcode project**

In Xcode:
1. Remove the auto-generated ContentView.swift (our ContentView is in DJToolkitSetupApp.swift)
2. Add all files from `DJToolkitSetup/Views/`, `DJToolkitSetup/Models/`, `DJToolkitSetup/Services/`
3. Set the custom Info.plist path in Build Settings → Packaging → Info.plist File to `DJToolkitSetup/Info.plist`
4. Add `AuthenticationServices.framework` to the target's Frameworks

- [ ] **Step 3: Build and verify in Xcode**

Run: `xcodebuild -project setup-assistant/DJToolkitSetup.xcodeproj -scheme DJToolkitSetup -configuration Debug build`
Expected: Build succeeds

- [ ] **Step 4: Commit the Xcode project**

```bash
git add setup-assistant/DJToolkitSetup.xcodeproj/
git commit -m "feat: add Xcode project for Setup Assistant"
```

---

### Task 11: Update build.sh to include Setup Assistant in DMG

**Files:**
- Modify: `packaging/macos/build.sh`

- [ ] **Step 1: Add Setup Assistant build and DMG staging**

Add after the PyInstaller step in `build.sh` (after the "Binary built" echo, before the .pkg step):

```bash
# ── 3b. Build Setup Assistant ─────────────────────────────────────────────
if [ -d "setup-assistant/DJToolkitSetup.xcodeproj" ]; then
    echo "Building Setup Assistant..."
    xcodebuild -project setup-assistant/DJToolkitSetup.xcodeproj \
        -scheme DJToolkitSetup \
        -configuration Release \
        -archivePath build/DJToolkitSetup.xcarchive \
        archive -quiet
    xcodebuild -exportArchive \
        -archivePath build/DJToolkitSetup.xcarchive \
        -exportOptionsPlist setup-assistant/ExportOptions.plist \
        -exportPath build/ -quiet
    cp -R "build/DJToolkit Setup.app" dist/
    echo "✓ Setup Assistant built"
else
    echo "⚠ Setup Assistant project not found, skipping"
fi
```

Update the DMG staging to include the .app:

```bash
# Replace the existing TMP_DMG_DIR section:
TMP_DMG_DIR=$(mktemp -d)
cp "$PKG_NAME" "$TMP_DMG_DIR/"
if [ -d "dist/DJToolkit Setup.app" ]; then
    cp -R "dist/DJToolkit Setup.app" "$TMP_DMG_DIR/"
fi
```

- [ ] **Step 2: Commit**

```bash
git add packaging/macos/build.sh
git commit -m "build: include Setup Assistant in DMG"
```

---

### Task 12: Update release.yml CI workflow

**Files:**
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Add Setup Assistant build step to CI**

Add after the "Install PyInstaller" step:

```yaml
      - name: Build Setup Assistant
        run: |
          xcodebuild -project setup-assistant/DJToolkitSetup.xcodeproj \
            -scheme DJToolkitSetup \
            -configuration Release \
            -archivePath build/DJToolkitSetup.xcarchive \
            archive -quiet
          xcodebuild -exportArchive \
            -archivePath build/DJToolkitSetup.xcarchive \
            -exportOptionsPlist setup-assistant/ExportOptions.plist \
            -exportPath build/ -quiet
          cp -R "build/DJToolkit Setup.app" dist/
          echo "✓ Setup Assistant built"
```

- [ ] **Step 2: Update Homebrew tarball step to include .app**

Replace the existing "Create Homebrew tarball" step:

```yaml
      - name: Create Homebrew tarball
        env:
          VERSION: ${{ github.ref_name }}
        run: |
          VERSION="${VERSION#v}"
          TAR_NAME="djtoolkit-${VERSION}-arm64.tar.gz"
          tar czf "${TAR_NAME}" -C dist djtoolkit "DJToolkit Setup.app"
          echo "TAR_NAME=${TAR_NAME}" >> "$GITHUB_ENV"
          echo "Created: ${TAR_NAME} ($(du -sh "${TAR_NAME}" | cut -f1))"
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: build Setup Assistant and include in release artifacts"
```

---

### Task 13: Update Homebrew formula

**Files:**
- Modify: `homebrew/Formula/djtoolkit.rb`

- [ ] **Step 1: Update formula to install .app and show caveats**

```ruby
class Djtoolkit < Formula
  desc "DJ music library toolkit — download, fingerprint, tag, and manage tracks"
  homepage "https://github.com/yenkz/djtoolkit"
  license "MIT"
  version "__VERSION__"

  url "https://github.com/yenkz/djtoolkit/releases/download/v__VERSION__/djtoolkit-__VERSION__-arm64.tar.gz"
  sha256 "__SHA256_ARM64__"

  depends_on "chromaprint"
  depends_on :macos

  def install
    bin.install "djtoolkit"
    (share/"djtoolkit").install "DJToolkit Setup.app" if Dir.exist?("DJToolkit Setup.app")
  end

  def caveats
    <<~EOS
      Run the setup wizard to configure djtoolkit:
        djtoolkit setup

      Or open the app directly:
        open #{share}/djtoolkit/DJToolkit\\ Setup.app
    EOS
  end
end
```

- [ ] **Step 2: Commit**

```bash
git add homebrew/Formula/djtoolkit.rb
git commit -m "brew: install Setup Assistant app and show caveats"
```

---

### Task 14: Add .gitignore entries and final verification

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Add Xcode build artifacts to .gitignore**

Add to `.gitignore`:

```
# Xcode
setup-assistant/build/
setup-assistant/DJToolkitSetup.xcodeproj/xcuserdata/
setup-assistant/DJToolkitSetup.xcodeproj/project.xcworkspace/xcuserdata/
*.xcarchive
DerivedData/
```

- [ ] **Step 2: Run the configure-headless tests**

Run: `poetry run pytest tests/test_configure_headless.py -v`
Expected: All tests PASS

- [ ] **Step 3: Run the full test suite**

Run: `poetry run pytest -v`
Expected: All tests PASS (no regressions)

- [ ] **Step 4: Build the Setup Assistant locally (if Xcode is available)**

Run: `xcodebuild -project setup-assistant/DJToolkitSetup.xcodeproj -scheme DJToolkitSetup build`
Expected: Build succeeds

- [ ] **Step 5: Commit**

```bash
git add .gitignore
git commit -m "chore: add Xcode build artifacts to .gitignore"
```
