using System.ComponentModel;
using System.Runtime.CompilerServices;

namespace DJToolkitSetup.Models;

public class SetupState : INotifyPropertyChanged
{
    private string _email = "";
    private string _apiKey = "";
    private string _slskUser = "";
    private string _slskPass = "";
    private string _acoustidKey = "";
    private string _downloadsDir = "";
    private int _pollInterval = 30;

    public string Email { get => _email; set => Set(ref _email, value); }
    public string ApiKey { get => _apiKey; set => Set(ref _apiKey, value); }
    public string SlskUser { get => _slskUser; set => Set(ref _slskUser, value); }
    public string SlskPass { get => _slskPass; set => Set(ref _slskPass, value); }
    public string AcoustidKey { get => _acoustidKey; set => Set(ref _acoustidKey, value); }
    public string DownloadsDir { get => _downloadsDir; set => Set(ref _downloadsDir, value); }
    public int PollInterval { get => _pollInterval; set => Set(ref _pollInterval, value); }

    public event PropertyChangedEventHandler? PropertyChanged;

    private void Set<T>(ref T field, T value, [CallerMemberName] string? name = null)
    {
        if (!Equals(field, value))
        {
            field = value;
            PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
        }
    }
}
