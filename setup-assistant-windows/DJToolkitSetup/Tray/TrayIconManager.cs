using System;
using System.Diagnostics;
using System.IO;
using H.NotifyIcon;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using DJToolkitSetup.Services;
using System.ComponentModel;

namespace DJToolkitSetup.Tray;

public sealed class TrayIconManager : IDisposable
{
    private readonly TaskbarIcon _trayIcon;
    private readonly ServiceMonitor _serviceMonitor;
    private readonly MenuFlyout _menu;
    private readonly MenuFlyoutItem _statusItem;
    private readonly MenuFlyoutItem _startItem;
    private readonly MenuFlyoutItem _stopItem;
    private readonly ToggleMenuFlyoutItem _startupToggle;

    public TrayIconManager(DispatcherQueue dispatcherQueue)
    {
        _serviceMonitor = new ServiceMonitor(dispatcherQueue);
        _serviceMonitor.StatusChanged += OnStatusChanged;

        // Build context menu
        _statusItem = new MenuFlyoutItem { Text = "Checking...", IsEnabled = false };
        _startItem = new MenuFlyoutItem { Text = "Start Agent" };
        _stopItem = new MenuFlyoutItem { Text = "Stop Agent" };
        _startupToggle = new ToggleMenuFlyoutItem { Text = "Run at Startup", IsChecked = StartupManager.IsEnabled };

        var openDownloads = new MenuFlyoutItem { Text = "Open Downloads Folder" };
        var openLogs = new MenuFlyoutItem { Text = "Open Logs" };
        var recentActivity = new MenuFlyoutItem { Text = "Recent Activity..." };
        var openDashboard = new MenuFlyoutItem { Text = "Open Web Dashboard" };
        var rerunSetup = new MenuFlyoutItem { Text = "Re-run Setup..." };
        var exit = new MenuFlyoutItem { Text = "Exit" };

        _startItem.Click += async (_, _) => { try { await CLIBridge.StartAgent(); } catch (Win32Exception) { /* UAC cancelled */ } _serviceMonitor.Poll(); };
        _stopItem.Click += async (_, _) => { try { await CLIBridge.StopAgent(); } catch (Win32Exception) { /* UAC cancelled */ } _serviceMonitor.Poll(); };
        _startupToggle.Click += OnStartupToggle;
        openDownloads.Click += OnOpenDownloads;
        openLogs.Click += OnOpenLogs;
        recentActivity.Click += OnRecentActivity;
        openDashboard.Click += (_, _) => Process.Start(new ProcessStartInfo("https://app.djtoolkit.net") { UseShellExecute = true });
        rerunSetup.Click += (_, _) => Process.Start(new ProcessStartInfo(Process.GetCurrentProcess().MainModule!.FileName) { UseShellExecute = true });
        exit.Click += (_, _) => Application.Current.Exit();

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
        _menu.Items.Add(openDashboard);
        _menu.Items.Add(rerunSetup);
        _menu.Items.Add(new MenuFlyoutSeparator());
        _menu.Items.Add(exit);

        // Create tray icon
        _trayIcon = new TaskbarIcon
        {
            ToolTipText = "djtoolkit Agent",
            ContextFlyout = _menu,
        };

        UpdateIcon(AgentStatus.NotInstalled);
        _serviceMonitor.Start();
    }

    private void OnStatusChanged(AgentStatus status)
    {
        UpdateIcon(status);
        _startItem.IsEnabled = status == AgentStatus.Stopped;
        _stopItem.IsEnabled = status == AgentStatus.Running;

        _statusItem.Text = status switch
        {
            AgentStatus.Running => "\u25cf Running",
            AgentStatus.Stopped => "\u25cf Stopped",
            AgentStatus.NotInstalled => "\u25cf Not Installed \u2014 run Setup to configure",
            _ => "Unknown",
        };
    }

    private void UpdateIcon(AgentStatus status)
    {
        var iconName = status switch
        {
            AgentStatus.Running => "tray-green.ico",
            AgentStatus.Stopped => "tray-gray.ico",
            _ => "tray-yellow.ico",
        };

        var iconPath = Path.Combine(AppContext.BaseDirectory, "Assets", iconName);
        if (File.Exists(iconPath))
        {
            _trayIcon.Icon = new System.Drawing.Icon(iconPath);
        }

        _trayIcon.ToolTipText = status switch
        {
            AgentStatus.Running => "djtoolkit Agent \u2014 Running",
            AgentStatus.Stopped => "djtoolkit Agent \u2014 Stopped",
            _ => "djtoolkit Agent \u2014 Not Installed",
        };
    }

    private async void OnStartupToggle(object sender, RoutedEventArgs e)
    {
        if (_startupToggle.IsChecked)
        {
            StartupManager.Enable();
            await CLIBridge.StartAgent();
        }
        else
        {
            StartupManager.Disable();
            await CLIBridge.StopAgent();
        }
        _serviceMonitor.Poll();
    }

    private void OnOpenDownloads(object sender, RoutedEventArgs e)
    {
        var dir = ConfigReader.DownloadsDir;
        if (!Directory.Exists(dir))
            Directory.CreateDirectory(dir);
        Process.Start(new ProcessStartInfo(dir) { UseShellExecute = true });
    }

    private async void OnOpenLogs(object sender, RoutedEventArgs e)
    {
        var logPath = ConfigReader.LogFilePath;
        if (File.Exists(logPath))
        {
            Process.Start(new ProcessStartInfo(logPath) { UseShellExecute = true });
        }
        else
        {
            var dialog = new ContentDialog
            {
                Title = "No Logs",
                Content = "No log file found. Start the agent first.",
                CloseButtonText = "OK",
                XamlRoot = _trayIcon.ContextFlyout?.XamlRoot,
            };
            await dialog.ShowAsync();
        }
    }

    private void OnRecentActivity(object sender, RoutedEventArgs e)
    {
        var window = new Views.ActivityWindow();
        window.Activate();
    }

    public void Dispose()
    {
        _serviceMonitor.Dispose();
        _trayIcon.Dispose();
    }
}
