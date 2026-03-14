using System;
using System.Diagnostics;
using DJToolkitSetup.Models;
using DJToolkitSetup.Services;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Navigation;

namespace DJToolkitSetup.Views;

public sealed partial class SignInPage : Page
{
    private SetupState? _state;
    private readonly OAuthService _oauth = new("https://YOUR_SUPABASE_URL.supabase.co");

    public SignInPage()
    {
        InitializeComponent();
    }

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        _state = e.Parameter as SetupState;
    }

    private void BrowserSignInButton_Click(object sender, RoutedEventArgs e)
    {
        var url = _oauth.GetAuthUrl();
        Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
        StatusText.Text = "Waiting for sign-in to complete in your browser...";
    }

    private async void ContinueButton_Click(object sender, RoutedEventArgs e)
    {
        if (_state == null) return;

        var apiKey = ApiKeyBox.Text.Trim();
        if (!string.IsNullOrEmpty(apiKey))
        {
            _state.ApiKey = apiKey;
            Frame.Navigate(typeof(SoulseekPage), _state);
            return;
        }

        StatusText.Text = "Please enter an API key or sign in with your browser.";
    }

    private void BackButton_Click(object sender, RoutedEventArgs e)
    {
        Frame.GoBack();
    }
}
