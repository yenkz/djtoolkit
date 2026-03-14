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
        ContentFrame.Navigate(typeof(WelcomePage), State);
    }
}
