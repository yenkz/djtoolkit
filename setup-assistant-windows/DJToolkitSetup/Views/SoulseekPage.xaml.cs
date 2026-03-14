using DJToolkitSetup.Models;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Navigation;

namespace DJToolkitSetup.Views;

public sealed partial class SoulseekPage : Page
{
    private SetupState? _state;

    public SoulseekPage()
    {
        InitializeComponent();
    }

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        _state = e.Parameter as SetupState;
        if (_state != null)
        {
            UsernameBox.Text = _state.SlskUser;
            PasswordBox.Password = _state.SlskPass;
        }
    }

    private void ContinueButton_Click(object sender, RoutedEventArgs e)
    {
        if (_state == null) return;
        _state.SlskUser = UsernameBox.Text.Trim();
        _state.SlskPass = PasswordBox.Password;
        Frame.Navigate(typeof(AcoustIDPage), _state);
    }

    private void BackButton_Click(object sender, RoutedEventArgs e)
    {
        Frame.GoBack();
    }
}
