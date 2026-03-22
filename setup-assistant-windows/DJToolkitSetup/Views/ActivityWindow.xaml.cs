using System;
using System.Collections.Generic;
using DJToolkitSetup.Tray;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Windows.Graphics;

namespace DJToolkitSetup.Views;

public record JobViewModel(string StatusIcon, string Description, string Subtitle);

public sealed partial class ActivityWindow : Window
{
    public ActivityWindow()
    {
        InitializeComponent();

        // Size and position
        var appWindow = this.AppWindow;
        appWindow.Resize(new SizeInt32(350, 400));

        // Position bottom-right of primary display
        var display = DisplayArea.Primary;
        var workArea = display.WorkArea;
        appWindow.Move(new PointInt32(
            workArea.X + workArea.Width - 360,
            workArea.Y + workArea.Height - 410));

        // Remove title bar for popup feel
        if (AppWindowTitleBar.IsCustomizationSupported())
        {
            appWindow.TitleBar.ExtendsContentIntoTitleBar = true;
        }

        LoadJobs();

        // Close on lost focus
        this.Activated += (_, args) =>
        {
            if (args.WindowActivationState == WindowActivationState.Deactivated)
                this.Close();
        };
    }

    private void LoadJobs()
    {
        var recentJobs = StatusReader.ReadRecentJobs();

        if (recentJobs.Count == 0)
        {
            EmptyMessage.Visibility = Visibility.Visible;
            JobList.Visibility = Visibility.Collapsed;
            return;
        }

        var viewModels = new List<JobViewModel>();
        foreach (var job in recentJobs)
        {
            var icon = job.Status == "completed" ? "\u2713" : "\u2717";
            var verb = job.JobType switch
            {
                "download" => "Downloaded",
                "fingerprint" => "Fingerprinted",
                "cover_art" => "Cover art for",
                "metadata" => "Tagged",
                _ => job.JobType,
            };
            var desc = $"{verb} \"{job.Title}\"";
            var ago = FormatTimeAgo(job.CompletedAt);
            var subtitle = $"{job.Artist} \u00b7 {ago}";

            viewModels.Add(new JobViewModel(icon, desc, subtitle));
        }

        JobList.ItemsSource = viewModels;
    }

    private static string FormatTimeAgo(DateTime dt)
    {
        var diff = DateTime.Now - dt;
        if (diff.TotalSeconds < 60) return "just now";
        if (diff.TotalMinutes < 60) return $"{(int)diff.TotalMinutes} min ago";
        if (diff.TotalHours < 24) return $"{(int)diff.TotalHours}h ago";
        return $"{(int)diff.TotalDays}d ago";
    }
}
