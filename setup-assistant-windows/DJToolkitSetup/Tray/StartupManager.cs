using System;
using System.Diagnostics;
using Microsoft.Win32;

namespace DJToolkitSetup.Tray;

public static class StartupManager
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "DJToolkit Agent";

    public static bool IsEnabled
    {
        get
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKey, false);
            return key?.GetValue(ValueName) != null;
        }
    }

    public static void Enable()
    {
        var exePath = Process.GetCurrentProcess().MainModule?.FileName
            ?? throw new InvalidOperationException("Cannot resolve executable path");

        using var key = Registry.CurrentUser.OpenSubKey(RunKey, true)
            ?? throw new InvalidOperationException("Cannot open Run registry key");

        key.SetValue(ValueName, $"\"{exePath}\" --tray");
    }

    public static void Disable()
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKey, true);
        key?.DeleteValue(ValueName, throwOnMissingValue: false);
    }
}
