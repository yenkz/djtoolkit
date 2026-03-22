# Windows Tray App v2 — Auto-Update, Reconfigure, Uninstall

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add auto-update, reconfigure agent, uninstall agent, periodic version check with notifications, and first-run wizard auto-launch to the existing Windows tray app.

**Architecture:** Extend the existing WinUI 3 tray app with 4 new classes (UpdateChecker, ConfigWriter, Uninstaller, ReconfigureWindow) and modify TrayIconManager to wire new menu items. Uses GitHub Releases API for updates, Tomlyn for config writing, toast notifications via WindowsAppSDK.

**Tech Stack:** C# / .NET 8, WinUI 3, H.NotifyIcon.WinUI 2.3.2, Tomlyn 0.17.x, WindowsAppSDK 1.6.x

**Spec:** `docs/superpowers/specs/2026-03-22-macos-tray-app-design.md` (cross-platform spec, Windows sections inline)

---

## File Structure

### New files

| File | Responsibility |
|------|---------------|
| `setup-assistant-windows/DJToolkitSetup/Tray/UpdateChecker.cs` | GitHub Releases API polling, version comparison, MSI download + launch |
| `setup-assistant-windows/DJToolkitSetup/Tray/ConfigWriter.cs` | Read-modify-write of config.toml via Tomlyn for reconfigure editor |
| `setup-assistant-windows/DJToolkitSetup/Tray/Uninstaller.cs` | Stop service, remove service, CLI binary, registry, optionally config dir |
| `setup-assistant-windows/DJToolkitSetup/Views/ReconfigureWindow.xaml` | WinUI 3 config editor form layout |
| `setup-assistant-windows/DJToolkitSetup/Views/ReconfigureWindow.xaml.cs` | Code-behind: load/save config, folder picker |

### Modified files

| File | Change |
|------|--------|
| `setup-assistant-windows/DJToolkitSetup/Tray/TrayIconManager.cs` | Add menu items: Reconfigure, Check for Updates, Uninstall. Wire UpdateChecker status badge. |
| `setup-assistant-windows/DJToolkitSetup/App.xaml.cs` | Add first-run detection (no config.toml → launch wizard) |

---

### Task 1: UpdateChecker — GitHub Releases API + version comparison

**Files:**
- Create: `setup-assistant-windows/DJToolkitSetup/Tray/UpdateChecker.cs`

Queries GitHub Releases API every 24h + on-demand, compares with assembly version, downloads MSI when user triggers update.

- [ ] **Step 1: Create UpdateChecker.cs**

```csharp
using System;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Json;
using System.Reflection;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.UI.Dispatching;

namespace DJToolkitSetup.Tray;

public sealed class UpdateChecker : IDisposable
{
    private static readonly HttpClient Http = new();
    private const string ApiUrl = "https://api.github.com/repos/yenkz/djtoolkit/releases/latest";
    private static readonly string CheckFilePath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "djtoolkit", "update-check.json");

    private DispatcherQueueTimer? _timer;
    private readonly DispatcherQueue _dispatcherQueue;

    public bool UpdateAvailable { get; private set; }
    public string? LatestVersion { get; private set; }
    public string? DownloadUrl { get; private set; }
    public bool IsDownloading { get; private set; }

    public event Action? StateChanged;

    public string CurrentVersion =>
        Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "0.0.0";

    public UpdateChecker(DispatcherQueue dispatcherQueue)
    {
        _dispatcherQueue = dispatcherQueue;
        Http.DefaultRequestHeaders.UserAgent.ParseAdd("djtoolkit-setup/1.0");
        Http.DefaultRequestHeaders.Accept.ParseAdd("application/vnd.github.v3+json");
        Http.Timeout = TimeSpan.FromSeconds(15);
    }

    /// Start periodic checking (24h timer) + delayed initial check (5s)
    public void StartPeriodicChecks()
    {
        // Delayed initial check
        _dispatcherQueue.TryEnqueue(async () =>
        {
            await Task.Delay(5000);
            await CheckForUpdatesAsync();
        });

        _timer = _dispatcherQueue.CreateTimer();
        _timer.Interval = TimeSpan.FromHours(24);
        _timer.Tick += async (_, _) => await CheckForUpdatesAsync();
        _timer.IsRepeating = true;
        _timer.Start();
    }

    /// Check GitHub Releases API for a newer version
    public async Task CheckForUpdatesAsync()
    {
        try
        {
            var response = await Http.GetAsync(ApiUrl);
            if (!response.IsSuccessStatusCode) return;

            using var doc = await JsonDocument.CreateAsync(await response.Content.ReadAsStreamAsync());
            var root = doc.RootElement;

            var tagName = root.GetProperty("tag_name").GetString() ?? "";
            var remoteVersion = tagName.TrimStart('v');

            if (!IsNewer(remoteVersion, CurrentVersion))
            {
                UpdateAvailable = false;
                LatestVersion = null;
                DownloadUrl = null;
                StateChanged?.Invoke();
                return;
            }

            // Find .msi asset
            string? msiUrl = null;
            if (root.TryGetProperty("assets", out var assets))
            {
                foreach (var asset in assets.EnumerateArray())
                {
                    var name = asset.GetProperty("name").GetString() ?? "";
                    if (name.EndsWith(".msi", StringComparison.OrdinalIgnoreCase))
                    {
                        msiUrl = asset.GetProperty("browser_download_url").GetString();
                        break;
                    }
                }
            }

            UpdateAvailable = true;
            LatestVersion = remoteVersion;
            DownloadUrl = msiUrl;
            SaveLastCheckTime();
            StateChanged?.Invoke();
        }
        catch
        {
            // Silent failure — retry next cycle
        }
    }

    /// Download and launch the MSI installer
    public async Task DownloadAndInstallAsync()
    {
        if (DownloadUrl is null)
        {
            MessageBox(IntPtr.Zero,
                "No installer found for your platform in the latest release.",
                "Update Not Available", MB_OK | 0x40); // MB_ICONINFORMATION
            return;
        }

        IsDownloading = true;
        StateChanged?.Invoke();

        try
        {
            var tempPath = Path.Combine(Path.GetTempPath(), "djtoolkit-update.msi");
            if (File.Exists(tempPath)) File.Delete(tempPath);

            using var stream = await Http.GetStreamAsync(DownloadUrl);
            using var fileStream = File.Create(tempPath);
            await stream.CopyToAsync(fileStream);
            fileStream.Close();

            // Launch MSI installer
            var psi = new System.Diagnostics.ProcessStartInfo
            {
                FileName = "msiexec",
                Arguments = $"/i \"{tempPath}\"",
                UseShellExecute = true,
            };
            System.Diagnostics.Process.Start(psi);

            // Quit after brief delay to let installer launch
            await Task.Delay(1000);
            Microsoft.UI.Xaml.Application.Current.Exit();
        }
        catch (Exception ex)
        {
            IsDownloading = false;
            StateChanged?.Invoke();

            MessageBox(IntPtr.Zero,
                $"Update download failed: {ex.Message}\n\nTry again later.",
                "Update Failed", 0x30); // MB_ICONWARNING
        }
    }

    [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    private static extern int MessageBox(IntPtr hWnd, string text, string caption, uint type);

    /// Semantic version comparison: is remote > current?
    private static bool IsNewer(string remote, string current)
    {
        var remoteParts = remote.Split('.').Select(s => int.TryParse(s, out var n) ? n : 0).ToArray();
        var currentParts = current.Split('.').Select(s => int.TryParse(s, out var n) ? n : 0).ToArray();

        var maxLen = Math.Max(remoteParts.Length, currentParts.Length);
        for (var i = 0; i < maxLen; i++)
        {
            var r = i < remoteParts.Length ? remoteParts[i] : 0;
            var c = i < currentParts.Length ? currentParts[i] : 0;
            if (r > c) return true;
            if (r < c) return false;
        }
        return false;
    }

    /// Whether notification has been sent for this version
    public bool ShouldNotify()
    {
        if (LatestVersion is null) return false;
        var lastNotified = ReadLastNotifiedVersion();
        return lastNotified != LatestVersion;
    }

    /// Mark notification as sent for current latest version
    public void MarkNotified()
    {
        if (LatestVersion is null) return;
        try
        {
            var dir = Path.GetDirectoryName(CheckFilePath)!;
            Directory.CreateDirectory(dir);
            var json = JsonSerializer.Serialize(new
            {
                lastCheck = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
                lastNotifiedVersion = LatestVersion
            });
            File.WriteAllText(CheckFilePath, json);
        }
        catch { /* ignore */ }
    }

    private void SaveLastCheckTime()
    {
        try
        {
            var dir = Path.GetDirectoryName(CheckFilePath)!;
            Directory.CreateDirectory(dir);
            // Preserve existing lastNotifiedVersion
            var existing = ReadLastNotifiedVersion() ?? "";
            var json = JsonSerializer.Serialize(new
            {
                lastCheck = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
                lastNotifiedVersion = existing
            });
            File.WriteAllText(CheckFilePath, json);
        }
        catch { /* ignore */ }
    }

    private static string? ReadLastNotifiedVersion()
    {
        try
        {
            if (!File.Exists(CheckFilePath)) return null;
            using var doc = JsonDocument.Parse(File.ReadAllText(CheckFilePath));
            return doc.RootElement.GetProperty("lastNotifiedVersion").GetString();
        }
        catch { return null; }
    }

    public void Dispose()
    {
        _timer?.Stop();
    }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `dotnet restore setup-assistant-windows/DJToolkitSetup/DJToolkitSetup.csproj -r win-x64 && dotnet build setup-assistant-windows/DJToolkitSetup/DJToolkitSetup.csproj -c Debug --no-restore 2>&1 | tail -5`

Note: If `dotnet build` fails with PRI errors, use `msbuild` instead (see ci-agents.yml for the exact command). The key thing is compilation succeeds.

- [ ] **Step 3: Commit**

```bash
git add setup-assistant-windows/DJToolkitSetup/Tray/UpdateChecker.cs
git commit -m "feat(windows-tray): add UpdateChecker for GitHub Releases auto-update"
```

---

### Task 2: ConfigWriter — Tomlyn-based config writing

**Files:**
- Create: `setup-assistant-windows/DJToolkitSetup/Tray/ConfigWriter.cs`

Read-modify-write of `config.toml` using Tomlyn (already a dependency). Preserves all existing keys.

- [ ] **Step 1: Create ConfigWriter.cs**

```csharp
using System;
using System.IO;
using Tomlyn;
using Tomlyn.Model;

namespace DJToolkitSetup.Tray;

public static class ConfigWriter
{
    private static readonly string ConfigPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "djtoolkit", "config.toml");

    public record EditableConfig(
        string DownloadsDir,
        string SoulseekUsername,
        string SoulseekPassword);

    /// Read editable config values from config.toml
    public static EditableConfig ReadConfig()
    {
        var defaultDir = ConfigReader.DownloadsDir;

        try
        {
            if (!File.Exists(ConfigPath))
                return new EditableConfig(defaultDir, "", "");

            var toml = Toml.ToModel(File.ReadAllText(ConfigPath));

            var downloadsDir = defaultDir;
            if (toml.TryGetValue("agent", out var agentObj)
                && agentObj is TomlTable agent
                && agent.TryGetValue("downloads_dir", out var dir)
                && dir is string dirStr && !string.IsNullOrWhiteSpace(dirStr))
            {
                downloadsDir = dirStr;
            }

            var slskUser = "";
            var slskPass = "";
            if (toml.TryGetValue("soulseek", out var slskObj)
                && slskObj is TomlTable slsk)
            {
                if (slsk.TryGetValue("username", out var u) && u is string us)
                    slskUser = us;
                if (slsk.TryGetValue("password", out var p) && p is string ps)
                    slskPass = ps;
            }

            return new EditableConfig(downloadsDir, slskUser, slskPass);
        }
        catch
        {
            return new EditableConfig(defaultDir, "", "");
        }
    }

    /// Write updated config values back to config.toml (read-modify-write)
    public static void WriteConfig(EditableConfig config)
    {
        var dir = Path.GetDirectoryName(ConfigPath)!;
        Directory.CreateDirectory(dir);

        TomlTable toml;
        try
        {
            if (File.Exists(ConfigPath))
                toml = Toml.ToModel(File.ReadAllText(ConfigPath));
            else
                toml = new TomlTable();
        }
        catch
        {
            toml = new TomlTable();
        }

        // Ensure [agent] section exists
        if (!toml.TryGetValue("agent", out var agentObj) || agentObj is not TomlTable agentTable)
        {
            agentTable = new TomlTable();
            toml["agent"] = agentTable;
        }
        agentTable["downloads_dir"] = config.DownloadsDir;

        // Ensure [soulseek] section exists
        if (!toml.TryGetValue("soulseek", out var slskObj) || slskObj is not TomlTable slskTable)
        {
            slskTable = new TomlTable();
            toml["soulseek"] = slskTable;
        }
        slskTable["username"] = config.SoulseekUsername;
        slskTable["password"] = config.SoulseekPassword;

        File.WriteAllText(ConfigPath, Toml.FromModel(toml));
    }
}
```

- [ ] **Step 2: Verify it compiles**

Build the project as in Task 1 Step 2.

- [ ] **Step 3: Commit**

```bash
git add setup-assistant-windows/DJToolkitSetup/Tray/ConfigWriter.cs
git commit -m "feat(windows-tray): add ConfigWriter for Tomlyn-based config editing"
```

---

### Task 3: ReconfigureWindow — WinUI 3 config editor

**Files:**
- Create: `setup-assistant-windows/DJToolkitSetup/Views/ReconfigureWindow.xaml`
- Create: `setup-assistant-windows/DJToolkitSetup/Views/ReconfigureWindow.xaml.cs`

Lightweight config editor window for downloads dir and Soulseek credentials.

- [ ] **Step 1: Create ReconfigureWindow.xaml**

```xml
<?xml version="1.0" encoding="utf-8"?>
<Window
    x:Class="DJToolkitSetup.Views.ReconfigureWindow"
    xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
    xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
    Title="Reconfigure djtoolkit Agent">

    <StackPanel Padding="24" Spacing="16">
        <TextBlock Text="Downloads" Style="{StaticResource SubtitleTextBlockStyle}" />
        <Grid ColumnSpacing="8">
            <Grid.ColumnDefinitions>
                <ColumnDefinition Width="*" />
                <ColumnDefinition Width="Auto" />
            </Grid.ColumnDefinitions>
            <TextBox x:Name="DownloadsDirBox" Header="Downloads Directory" PlaceholderText="~/Music/djtoolkit/downloads" />
            <Button Grid.Column="1" Content="Browse..." Click="OnBrowse" VerticalAlignment="Bottom" Margin="0,0,0,1" />
        </Grid>

        <TextBlock Text="Soulseek" Style="{StaticResource SubtitleTextBlockStyle}" Margin="0,8,0,0" />
        <TextBox x:Name="SlskUsernameBox" Header="Username" />
        <PasswordBox x:Name="SlskPasswordBox" Header="Password" />

        <TextBlock x:Name="StatusText" Foreground="Green" Visibility="Collapsed" />

        <StackPanel Orientation="Horizontal" HorizontalAlignment="Right" Spacing="8" Margin="0,8,0,0">
            <Button Content="Cancel" Click="OnCancel" />
            <Button Content="Save" Style="{StaticResource AccentButtonStyle}" Click="OnSave" />
        </StackPanel>
    </StackPanel>
</Window>
```

- [ ] **Step 2: Create ReconfigureWindow.xaml.cs**

```csharp
using System;
using DJToolkitSetup.Tray;
using Microsoft.UI.Xaml;
using Windows.Storage.Pickers;

namespace DJToolkitSetup.Views;

public sealed partial class ReconfigureWindow : Window
{
    private readonly bool _agentRunning;

    public ReconfigureWindow(bool agentRunning = false)
    {
        InitializeComponent();
        _agentRunning = agentRunning;

        // Set window size
        var appWindow = this.AppWindow;
        appWindow.Resize(new Windows.Graphics.SizeInt32(420, 380));

        LoadConfig();
    }

    private void LoadConfig()
    {
        var config = ConfigWriter.ReadConfig();
        DownloadsDirBox.Text = config.DownloadsDir;
        SlskUsernameBox.Text = config.SoulseekUsername;
        SlskPasswordBox.Password = config.SoulseekPassword;
    }

    private void OnSave(object sender, RoutedEventArgs e)
    {
        try
        {
            var config = new ConfigWriter.EditableConfig(
                DownloadsDirBox.Text,
                SlskUsernameBox.Text,
                SlskPasswordBox.Password);

            ConfigWriter.WriteConfig(config);

            StatusText.Text = _agentRunning
                ? "Saved — restart the agent for changes to take effect."
                : "Saved";
            StatusText.Visibility = Visibility.Visible;

            // Auto-hide status after 3s
            var timer = DispatcherQueue.CreateTimer();
            timer.Interval = TimeSpan.FromSeconds(3);
            timer.Tick += (_, _) =>
            {
                StatusText.Visibility = Visibility.Collapsed;
                timer.Stop();
            };
            timer.Start();
        }
        catch (Exception ex)
        {
            StatusText.Foreground = new Microsoft.UI.Xaml.Media.SolidColorBrush(
                Microsoft.UI.Colors.Red);
            StatusText.Text = $"Failed to save: {ex.Message}";
            StatusText.Visibility = Visibility.Visible;
        }
    }

    private void OnCancel(object sender, RoutedEventArgs e)
    {
        Close();
    }

    private async void OnBrowse(object sender, RoutedEventArgs e)
    {
        var picker = new FolderPicker();
        picker.SuggestedStartLocation = PickerLocationId.MusicLibrary;
        picker.FileTypeFilter.Add("*");

        // Initialize the picker with the window handle
        var hwnd = WinRT.Interop.WindowNative.GetWindowHandle(this);
        WinRT.Interop.InitializeWithWindow.Initialize(picker, hwnd);

        var folder = await picker.PickSingleFolderAsync();
        if (folder != null)
        {
            DownloadsDirBox.Text = folder.Path;
        }
    }
}
```

- [ ] **Step 3: Verify it compiles**

Build the project as in Task 1 Step 2.

- [ ] **Step 4: Commit**

```bash
git add setup-assistant-windows/DJToolkitSetup/Views/ReconfigureWindow.xaml setup-assistant-windows/DJToolkitSetup/Views/ReconfigureWindow.xaml.cs
git commit -m "feat(windows-tray): add ReconfigureWindow for lightweight config editing"
```

---

### Task 4: Uninstaller — agent removal logic

**Files:**
- Create: `setup-assistant-windows/DJToolkitSetup/Tray/Uninstaller.cs`

Handles all uninstall steps: stop service, remove service, CLI binary, registry, optionally config dir.

- [ ] **Step 1: Create Uninstaller.cs**

```csharp
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using DJToolkitSetup.Services;

namespace DJToolkitSetup.Tray;

public enum UninstallLevel { KeepSettings, RemoveAll }

public static class Uninstaller
{
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int MessageBox(IntPtr hWnd, string text, string caption, uint type);
    private const uint MB_YESNOCANCEL = 0x3;
    private const uint MB_ICONWARNING = 0x30;
    private const uint MB_ICONINFORMATION = 0x40;
    private const uint MB_OK = 0x0;
    private const int IDYES = 6;
    private const int IDNO = 7;

    private static readonly string AppDataDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "djtoolkit");
    private static readonly string LogDir = Path.Combine(AppDataDir, "logs");

    /// Show uninstall confirmation dialog. Returns null if cancelled.
    public static UninstallLevel? ShowConfirmation()
    {
        // First ask: do they want to uninstall at all?
        var result = MessageBox(IntPtr.Zero,
            "Uninstall djtoolkit Agent?\n\nThis will stop the agent service, remove the CLI tool, and remove auto-start entries.\n\nDo you also want to remove all settings and data?",
            "Uninstall djtoolkit",
            MB_YESNOCANCEL | MB_ICONWARNING);

        return result switch
        {
            IDYES => UninstallLevel.RemoveAll,
            IDNO => UninstallLevel.KeepSettings,
            _ => null // Cancel
        };
    }

    /// Perform uninstall. Returns list of any errors encountered.
    public static List<string> Uninstall(UninstallLevel level)
    {
        var errors = new List<string>();

        // 1. Stop agent service (needs elevation, same as Start/Stop in TrayIconManager)
        try
        {
            RunElevated("sc", "stop DJToolkitAgent");
            // Ignore errors — service may already be stopped
        }
        catch (Exception ex) { errors.Add($"Stop service: {ex.Message}"); }

        // 2. Remove Windows service (requires elevation)
        try
        {
            RunElevated("sc", "delete DJToolkitAgent");
        }
        catch (Exception ex) { errors.Add($"Remove service: {ex.Message}"); }

        // 3. Remove CLI binary
        try
        {
            var programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            var cliDir = Path.Combine(programFiles, "djtoolkit");
            if (Directory.Exists(cliDir))
            {
                // Need elevation to delete from Program Files
                RunElevated("cmd", $"/c rmdir /s /q \"{cliDir}\"");
            }
        }
        catch (Exception ex) { errors.Add($"Remove CLI: {ex.Message}"); }

        // 4. Remove startup registry entry
        try
        {
            StartupManager.Disable();
        }
        catch (Exception ex) { errors.Add($"Remove startup entry: {ex.Message}"); }

        // 5. Remove log files
        try
        {
            if (Directory.Exists(LogDir))
                Directory.Delete(LogDir, recursive: true);
        }
        catch (Exception ex) { errors.Add($"Remove logs: {ex.Message}"); }

        // 6. Remove config/data (full cleanup)
        if (level == UninstallLevel.RemoveAll)
        {
            try
            {
                if (Directory.Exists(AppDataDir))
                    Directory.Delete(AppDataDir, recursive: true);
            }
            catch (Exception ex) { errors.Add($"Remove config: {ex.Message}"); }
        }

        return errors;
    }

    /// Show completion dialog
    public static void ShowCompletion(List<string> errors)
    {
        if (errors.Count == 0)
        {
            MessageBox(IntPtr.Zero,
                "djtoolkit has been uninstalled.",
                "Uninstall Complete",
                MB_OK | MB_ICONINFORMATION);
        }
        else
        {
            MessageBox(IntPtr.Zero,
                "Uninstall completed with warnings:\n\n" + string.Join("\n", errors),
                "Uninstall Complete",
                MB_OK | MB_ICONWARNING);
        }
    }

    private static string RunProcess(string fileName, string arguments)
    {
        var psi = new ProcessStartInfo
        {
            FileName = fileName,
            Arguments = arguments,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        using var proc = Process.Start(psi)!;
        var output = proc.StandardOutput.ReadToEnd();
        proc.WaitForExit();
        return output;
    }

    private static void RunElevated(string fileName, string arguments)
    {
        var psi = new ProcessStartInfo
        {
            FileName = fileName,
            Arguments = arguments,
            UseShellExecute = true,
            Verb = "runas",
        };
        using var proc = Process.Start(psi)!;
        proc.WaitForExit();
    }
}
```

- [ ] **Step 2: Verify it compiles**

Build the project as in Task 1 Step 2.

- [ ] **Step 3: Commit**

```bash
git add setup-assistant-windows/DJToolkitSetup/Tray/Uninstaller.cs
git commit -m "feat(windows-tray): add Uninstaller with cleanup level choice"
```

---

### Task 5: Integrate new features into TrayIconManager

**Files:**
- Modify: `setup-assistant-windows/DJToolkitSetup/Tray/TrayIconManager.cs`

Add UpdateChecker, new menu items (Reconfigure, Check for Updates, Uninstall), and wire up toast notifications.

- [ ] **Step 1: Add new fields**

Add after the `_startupToggle` field declaration:

```csharp
    private readonly UpdateChecker _updateChecker;
    private readonly MenuFlyoutItem _updateItem;
```

- [ ] **Step 2: Initialize UpdateChecker in constructor**

Add after `_serviceMonitor.StatusChanged += OnStatusChanged;`:

```csharp
        _updateChecker = new UpdateChecker(dispatcherQueue);
        _updateChecker.StateChanged += OnUpdateStateChanged;
```

Add after `_serviceMonitor.Start();`:

```csharp
        _updateChecker.StartPeriodicChecks();
```

- [ ] **Step 3: Add new menu items**

Add these variables after `var rerunSetup`:

```csharp
        var reconfigure = new MenuFlyoutItem { Text = "Reconfigure Agent..." };
        _updateItem = new MenuFlyoutItem { Text = "Check for Updates" };
        var uninstall = new MenuFlyoutItem { Text = "Uninstall Agent..." };
```

Add click handlers after `rerunSetup.Click += ...`:

```csharp
        reconfigure.Click += OnReconfigure;
        _updateItem.Click += OnUpdateClick;
        uninstall.Click += OnUninstall;
```

Replace the menu construction block (lines 57-72) with:

```csharp
        _menu = new MenuFlyout();
        _menu.Items.Add(_statusItem);
        _menu.Items.Add(new MenuFlyoutSeparator());
        _menu.Items.Add(_startItem);
        _menu.Items.Add(_stopItem);
        _menu.Items.Add(new MenuFlyoutSeparator());
        _menu.Items.Add(_startupToggle);
        _menu.Items.Add(new MenuFlyoutSeparator());
        _menu.Items.Add(openDownloads);
        _menu.Items.Add(openLogs);
        _menu.Items.Add(recentActivity);
        _menu.Items.Add(new MenuFlyoutSeparator());
        _menu.Items.Add(reconfigure);
        _menu.Items.Add(openDashboard);
        _menu.Items.Add(rerunSetup);
        _menu.Items.Add(new MenuFlyoutSeparator());
        _menu.Items.Add(_updateItem);
        _menu.Items.Add(new MenuFlyoutSeparator());
        _menu.Items.Add(uninstall);
        _menu.Items.Add(exit);
```

- [ ] **Step 4: Add handler methods**

Add these methods to the class:

```csharp
    private void OnUpdateStateChanged()
    {
        // Update icon badge — add blue overlay when update available
        UpdateIconBadge();

        if (_updateChecker.IsDownloading)
        {
            _updateItem.Text = "Downloading update...";
            _updateItem.IsEnabled = false;
        }
        else if (_updateChecker.UpdateAvailable && _updateChecker.LatestVersion != null)
        {
            _updateItem.Text = $"Update Available (v{_updateChecker.LatestVersion})";
            _updateItem.IsEnabled = true;
            _updateItem.FontWeight = Microsoft.UI.Text.FontWeights.Bold;

            // Send toast notification (once per version)
            if (_updateChecker.ShouldNotify())
            {
                SendUpdateToast(_updateChecker.LatestVersion);
                _updateChecker.MarkNotified();
            }
        }
        else
        {
            _updateItem.Text = "Check for Updates";
            _updateItem.IsEnabled = true;
            _updateItem.FontWeight = Microsoft.UI.Text.FontWeights.Normal;
        }
    }

    private async void OnUpdateClick(object sender, RoutedEventArgs e)
    {
        if (_updateChecker.UpdateAvailable)
            await _updateChecker.DownloadAndInstallAsync();
        else
            await _updateChecker.CheckForUpdatesAsync();
    }

    private void OnReconfigure(object sender, RoutedEventArgs e)
    {
        var isRunning = _serviceMonitor.CurrentStatus == AgentStatus.Running;
        var window = new Views.ReconfigureWindow(isRunning);
        window.Activate();
    }

    private void OnUninstall(object sender, RoutedEventArgs e)
    {
        var level = Uninstaller.ShowConfirmation();
        if (level is null) return;

        var errors = Uninstaller.Uninstall(level.Value);
        Uninstaller.ShowCompletion(errors);

        // Quit tray app
        Dispose();
        Application.Current.Exit();
    }

    /// Composite a blue dot onto the current tray icon when update is available
    private void UpdateIconBadge()
    {
        // Re-apply the current status icon — the blue dot is composited on top
        var status = _serviceMonitor.CurrentStatus;
        var iconName = status switch
        {
            AgentStatus.Running => "tray-green.ico",
            AgentStatus.Stopped => "tray-gray.ico",
            _ => "tray-yellow.ico",
        };

        var iconPath = Path.Combine(AppContext.BaseDirectory, "Assets", iconName);
        if (!File.Exists(iconPath)) return;

        using var baseIcon = new System.Drawing.Icon(iconPath);
        if (!_updateChecker.UpdateAvailable)
        {
            _trayIcon.Icon = baseIcon;
            return;
        }

        // Draw blue badge at top-right corner
        using var bmp = baseIcon.ToBitmap();
        using var g = System.Drawing.Graphics.FromImage(bmp);
        var dotSize = 6;
        g.FillEllipse(System.Drawing.Brushes.DodgerBlue,
            bmp.Width - dotSize - 1, 1, dotSize, dotSize);
        _trayIcon.Icon = System.Drawing.Icon.FromHandle(bmp.GetHicon());
    }

    private static void SendUpdateToast(string version)
    {
        try
        {
            var builder = new Microsoft.Windows.AppNotifications.Builder.AppNotificationBuilder()
                .AddText("djtoolkit Update Available")
                .AddText($"Version {version} is ready to install.");
            Microsoft.Windows.AppNotifications.AppNotificationManager.Default.Show(builder.BuildNotification());
        }
        catch { /* Toast may fail silently if app not registered */ }
    }
```

- [ ] **Step 5: Update Dispose**

Replace the `Dispose` method:

```csharp
    public void Dispose()
    {
        _serviceMonitor.Dispose();
        _updateChecker.Dispose();
        _trayIcon.Dispose();
    }
```

- [ ] **Step 6: Verify it compiles**

Build the project as in Task 1 Step 2.

- [ ] **Step 7: Commit**

```bash
git add setup-assistant-windows/DJToolkitSetup/Tray/TrayIconManager.cs
git commit -m "feat(windows-tray): integrate auto-update, reconfigure, and uninstall into menu"
```

---

### Task 6: First-run detection in App.xaml.cs

**Files:**
- Modify: `setup-assistant-windows/DJToolkitSetup/App.xaml.cs`

When launching with `--tray` and no `config.toml` exists, auto-launch the setup wizard.

- [ ] **Step 1: Add first-run check to tray mode launch**

Replace the tray mode block (lines 38-39) with:

```csharp
            // Tray mode: no window, just tray icon
            _trayManager = new TrayIconManager(DispatcherQueue.GetForCurrentThread());

            // First-run: if no config exists, auto-launch wizard
            var configPath = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "djtoolkit", "config.toml");
            if (!File.Exists(configPath))
            {
                var exePath = Process.GetCurrentProcess().MainModule?.FileName;
                if (exePath != null)
                {
                    Process.Start(new ProcessStartInfo(exePath) { UseShellExecute = true });
                }
            }
```

Add the required using at the top of the file (if not already present):

```csharp
using System.Diagnostics;
using System.IO;
```

- [ ] **Step 2: Verify it compiles**

Build the project as in Task 1 Step 2.

- [ ] **Step 3: Commit**

```bash
git add setup-assistant-windows/DJToolkitSetup/App.xaml.cs
git commit -m "feat(windows-tray): add first-run wizard auto-launch when config missing"
```

---

### Task 7: End-to-end verification

- [ ] **Step 1: Build Release**

```bash
dotnet restore setup-assistant-windows/DJToolkitSetup/DJToolkitSetup.csproj -r win-x64
msbuild setup-assistant-windows/DJToolkitSetup/DJToolkitSetup.csproj /p:Configuration=Release /p:Platform=x64 /p:RuntimeIdentifier=win-x64 /v:minimal
```

Expected: Build succeeded.

Note: If building on macOS (CI or local), use the CI workflow command from `ci-agents.yml`. This task builds correctly on `windows-latest` in CI.

- [ ] **Step 2: Verify CI build command matches**

Check that `ci-agents.yml` still has the correct build command for the Windows agent. The build should pick up new `.cs` and `.xaml` files automatically since they're in the project directory.

- [ ] **Step 3: Commit**

```bash
git add -A setup-assistant-windows/
git commit -m "feat(windows-tray): v2 — auto-update, reconfigure, uninstall, version check

Adds GitHub Releases auto-update with toast notification, lightweight
config editor via Tomlyn, agent uninstaller with cleanup level choice,
periodic version check, and first-run wizard auto-launch."
```
