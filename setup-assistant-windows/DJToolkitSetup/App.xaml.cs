using System;
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
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        var cmdArgs = Environment.GetCommandLineArgs().Skip(1).ToArray();
        var isTrayMode = cmdArgs.Any(a => a == "--tray");

        if (isTrayMode)
        {
            // Single-instance guard for tray mode
            _trayMutex = new Mutex(true, @"Local\DJToolkitTray", out var createdNew);
            if (!createdNew)
            {
                // Another tray instance is already running
                Exit();
                return;
            }

            // Tray mode: no window, just tray icon
            _trayManager = new TrayIconManager(DispatcherQueue.GetForCurrentThread());
        }
        else
        {
            // Setup wizard mode (default)
            MainWindow = new MainWindow();
            MainWindow.Activate();
        }
    }
}
