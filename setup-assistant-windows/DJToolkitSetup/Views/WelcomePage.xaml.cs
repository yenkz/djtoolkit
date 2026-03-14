using DJToolkitSetup.Models;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Navigation;

namespace DJToolkitSetup.Views;

public sealed partial class WelcomePage : Page
{
    private SetupState? _state;

    public WelcomePage()
    {
        InitializeComponent();
    }

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        _state = e.Parameter as SetupState;
    }

    private void GetStartedButton_Click(object sender, RoutedEventArgs e)
    {
        Frame.Navigate(typeof(SignInPage), _state);
    }
}
