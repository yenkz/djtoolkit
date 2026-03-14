using DJToolkitSetup.Models;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Navigation;

namespace DJToolkitSetup.Views;

public sealed partial class AcoustIDPage : Page
{
    private SetupState? _state;

    public AcoustIDPage()
    {
        InitializeComponent();
    }

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        _state = e.Parameter as SetupState;
        if (_state != null)
        {
            AcoustidKeyBox.Text = _state.AcoustidKey;
        }
    }

    private void ContinueButton_Click(object sender, RoutedEventArgs e)
    {
        if (_state == null) return;
        _state.AcoustidKey = AcoustidKeyBox.Text.Trim();
        Frame.Navigate(typeof(ConfirmPage), _state);
    }

    private void SkipButton_Click(object sender, RoutedEventArgs e)
    {
        Frame.Navigate(typeof(ConfirmPage), _state);
    }

    private void BackButton_Click(object sender, RoutedEventArgs e)
    {
        Frame.GoBack();
    }
}
