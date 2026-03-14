using DJToolkitSetup.Models;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Navigation;

namespace DJToolkitSetup.Views;

public sealed partial class DonePage : Page
{
    public DonePage()
    {
        InitializeComponent();
    }

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        // State passed through for consistency but not needed on this page.
    }

    private void CloseButton_Click(object sender, RoutedEventArgs e)
    {
        Application.Current.Exit();
    }
}
