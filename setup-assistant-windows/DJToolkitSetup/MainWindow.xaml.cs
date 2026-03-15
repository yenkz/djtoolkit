using DJToolkitSetup.Models;
using DJToolkitSetup.Views;
using Microsoft.UI.Xaml;

namespace DJToolkitSetup;

public sealed partial class MainWindow : Window
{
    public SetupState State { get; } = new();

    public MainWindow()
    {
        InitializeComponent();

        // WinUI 3 Window has no Width/Height XAML properties — set via AppWindow
        var appWindow = this.AppWindow;
        appWindow.Resize(new Windows.Graphics.SizeInt32(600, 500));

        ContentFrame.Navigate(typeof(WelcomePage), State);
    }
}
