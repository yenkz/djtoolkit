using System;
using System.IO;
using Tomlyn;
using Tomlyn.Model;

namespace DJToolkitSetup.Tray;

public static class ConfigReader
{
    private static readonly string ConfigPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "djtoolkit", "config.toml");

    private static readonly string DefaultDownloadsDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.MyMusic),
        "djtoolkit", "downloads");

    public static string DownloadsDir
    {
        get
        {
            try
            {
                if (!File.Exists(ConfigPath)) return DefaultDownloadsDir;

                var toml = Toml.ToModel(File.ReadAllText(ConfigPath));
                if (toml.TryGetValue("agent", out var agentObj)
                    && agentObj is TomlTable agent
                    && agent.TryGetValue("downloads_dir", out var dir)
                    && dir is string dirStr
                    && !string.IsNullOrWhiteSpace(dirStr))
                {
                    return dirStr;
                }
            }
            catch { /* fall through to default */ }

            return DefaultDownloadsDir;
        }
    }

    public static string LogFilePath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "djtoolkit", "logs", "agent.log");
}
