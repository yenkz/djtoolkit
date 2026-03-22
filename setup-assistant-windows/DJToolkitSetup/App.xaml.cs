using System;
using System.Diagnostics;
using System.Linq;
using System.Threading;
using DJToolkitSetup.Tray;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;

namespace DJToolkitSetup;

public partial class App : Application
{
    public static Window MainWindow { get; private set; } = null!;

    private TrayIconManager? _trayManager;
    private static Mutex? _trayMutex;

    public App()
    {
        InitializeComponent();
        UnhandledException += (_, e) =>
        {
            ShowCliFallback($"Unhandled error: {e.Message}");
            e.Handled = true;
        };
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        try
        {
            var cmdArgs = Environment.GetCommandLineArgs().Skip(1).ToArray();
            var isTrayMode = cmdArgs.Any(a => a == "--tray");

            if (isTrayMode)
            {
                // Single-instance guard for tray mode
                _trayMutex = new Mutex(true, @"Local\DJToolkitTray", out var createdNew);
                if (!createdNew)
                {
                    Exit();
                    return;
                }

                _trayManager = new TrayIconManager(DispatcherQueue.GetForCurrentThread());
            }
            else
            {
                MainWindow = new MainWindow();
                MainWindow.Activate();
            }
        }
        catch (Exception ex)
        {
            ShowCliFallback(ex.Message);
        }
    }

    private static void ShowCliFallback(string error)
    {
        var msg = $"/k echo DJToolkit Setup Assistant failed to start. && " +
                  $"echo Error: {error} && echo. && " +
                  "echo You can configure the agent manually: && " +
                  "echo   djtoolkit agent configure && " +
                  "echo   djtoolkit agent install";
        Process.Start(new ProcessStartInfo("cmd.exe", msg) { UseShellExecute = true });
    }
}
