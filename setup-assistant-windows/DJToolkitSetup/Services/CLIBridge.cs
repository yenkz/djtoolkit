using System;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;

namespace DJToolkitSetup.Services;

public record CLIResult(int ExitCode, string Stdout, string Stderr);

public static class CLIBridge
{
    private static string ResolveBinary()
    {
        var programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        var msiPath = Path.Combine(programFiles, "djtoolkit", "djtoolkit.exe");
        if (File.Exists(msiPath)) return msiPath;

        var pathDirs = Environment.GetEnvironmentVariable("PATH")?.Split(';') ?? [];
        foreach (var dir in pathDirs)
        {
            var candidate = Path.Combine(dir, "djtoolkit.exe");
            if (File.Exists(candidate)) return candidate;
        }

        var adjacent = Path.Combine(AppContext.BaseDirectory, "djtoolkit.exe");
        if (File.Exists(adjacent)) return adjacent;

        throw new FileNotFoundException("djtoolkit.exe not found");
    }

    public static async Task<CLIResult> RunAsync(string[] args, string? stdin = null, bool elevate = false)
    {
        var binary = ResolveBinary();
        var psi = new ProcessStartInfo
        {
            FileName = binary,
            RedirectStandardInput = stdin != null && !elevate,
            RedirectStandardOutput = !elevate,
            RedirectStandardError = !elevate,
            UseShellExecute = elevate,
            CreateNoWindow = !elevate,
        };
        foreach (var arg in args) psi.ArgumentList.Add(arg);

        if (elevate)
        {
            psi.Verb = "runas";
        }

        using var proc = Process.Start(psi) ?? throw new Exception("Failed to start process");

        if (stdin != null && !elevate)
        {
            await proc.StandardInput.WriteAsync(stdin);
            proc.StandardInput.Close();
        }

        string stdout = "", stderr = "";
        if (!elevate)
        {
            stdout = await proc.StandardOutput.ReadToEndAsync();
            stderr = await proc.StandardError.ReadToEndAsync();
        }

        await proc.WaitForExitAsync();
        return new CLIResult(proc.ExitCode, stdout, stderr);
    }

    public static Task<CLIResult> StartAgent() =>
        RunAsync(["agent", "start"], elevate: true);

    public static Task<CLIResult> StopAgent() =>
        RunAsync(["agent", "stop"], elevate: true);
}
