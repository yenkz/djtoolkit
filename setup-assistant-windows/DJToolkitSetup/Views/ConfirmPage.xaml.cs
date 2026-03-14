using System;
using System.Text.Json;
using DJToolkitSetup.Models;
using DJToolkitSetup.Services;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Navigation;
using Windows.Storage.Pickers;

namespace DJToolkitSetup.Views;

public sealed partial class ConfirmPage : Page
{
    private SetupState? _state;

    public ConfirmPage()
    {
        InitializeComponent();
    }

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        _state = e.Parameter as SetupState;
        if (_state == null) return;

        var maskedKey = _state.ApiKey.Length > 8
            ? _state.ApiKey[..4] + "..." + _state.ApiKey[^4..]
            : "(not set)";
        ApiKeySummary.Text = $"API Key: {maskedKey}";
        SlskSummary.Text = $"Soulseek: {(_state.SlskUser.Length > 0 ? _state.SlskUser : "(not set)")}";
        AcoustidSummary.Text = $"AcoustID: {(_state.AcoustidKey.Length > 0 ? "configured" : "skipped")}";

        DownloadsDirBox.Text = _state.DownloadsDir;
        PollSlider.Value = _state.PollInterval;
        PollValueText.Text = _state.PollInterval.ToString();
    }

    private void PollSlider_ValueChanged(object sender, Microsoft.UI.Xaml.Controls.Primitives.RangeBaseValueChangedEventArgs e)
    {
        if (PollValueText != null)
        {
            PollValueText.Text = ((int)e.NewValue).ToString();
        }
    }

    private async void BrowseButton_Click(object sender, RoutedEventArgs e)
    {
        var picker = new FolderPicker();
        picker.SuggestedStartLocation = PickerLocationId.MusicLibrary;
        picker.FileTypeFilter.Add("*");

        var hwnd = WinRT.Interop.WindowNative.GetWindowHandle(
            (Application.Current as App)!.GetType().GetProperty("_window",
                System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)
                ?.GetValue(Application.Current) as Window);
        WinRT.Interop.InitializeWithWindow.Initialize(picker, hwnd);

        var folder = await picker.PickSingleFolderAsync();
        if (folder != null && _state != null)
        {
            _state.DownloadsDir = folder.Path;
            DownloadsDirBox.Text = folder.Path;
        }
    }

    private async void InstallButton_Click(object sender, RoutedEventArgs e)
    {
        if (_state == null) return;

        _state.PollInterval = (int)PollSlider.Value;
        InstallButton.IsEnabled = false;
        StatusText.Text = "Configuring agent...";

        try
        {
            var config = JsonSerializer.Serialize(new
            {
                api_key = _state.ApiKey,
                slsk_user = _state.SlskUser,
                slsk_pass = _state.SlskPass,
                acoustid_key = _state.AcoustidKey,
                downloads_dir = _state.DownloadsDir,
                poll_interval = _state.PollInterval,
            });

            var configResult = await CLIBridge.RunAsync(
                ["agent", "configure-headless", "--stdin"], stdin: config);

            if (configResult.ExitCode != 0)
            {
                StatusText.Text = $"Configuration failed: {configResult.Stderr}";
                InstallButton.IsEnabled = true;
                return;
            }

            StatusText.Text = "Installing agent service (admin required)...";
            var installResult = await CLIBridge.RunAsync(["agent", "install"], elevate: true);

            if (installResult.ExitCode != 0)
            {
                StatusText.Text = "Agent installation failed. You may need to run as administrator.";
                InstallButton.IsEnabled = true;
                return;
            }

            Frame.Navigate(typeof(DonePage), _state);
        }
        catch (Exception ex)
        {
            StatusText.Text = $"Error: {ex.Message}";
            InstallButton.IsEnabled = true;
        }
    }

    private void BackButton_Click(object sender, RoutedEventArgs e)
    {
        Frame.GoBack();
    }
}
