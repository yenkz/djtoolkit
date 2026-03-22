using System;
using System.ServiceProcess;
using Microsoft.UI.Dispatching;

namespace DJToolkitSetup.Tray;

public enum AgentStatus { Running, Stopped, NotInstalled }

public sealed class ServiceMonitor : IDisposable
{
    private const string ServiceName = "DJToolkitAgent";
    private readonly DispatcherQueueTimer _timer;
    private AgentStatus _lastStatus = AgentStatus.NotInstalled;

    public event Action<AgentStatus>? StatusChanged;
    public AgentStatus CurrentStatus => _lastStatus;

    public ServiceMonitor(DispatcherQueue dispatcherQueue)
    {
        _timer = dispatcherQueue.CreateTimer();
        _timer.Interval = TimeSpan.FromSeconds(10);
        _timer.Tick += (_, _) => Poll();
        _timer.IsRepeating = true;
    }

    public void Start()
    {
        Poll(); // immediate first check
        _timer.Start();
    }

    public void Stop() => _timer.Stop();

    public void Poll()
    {
        var status = QueryStatus();
        if (status != _lastStatus)
        {
            _lastStatus = status;
            StatusChanged?.Invoke(status);
        }
    }

    private static AgentStatus QueryStatus()
    {
        try
        {
            using var sc = new ServiceController(ServiceName);
            return sc.Status == ServiceControllerStatus.Running
                ? AgentStatus.Running
                : AgentStatus.Stopped;
        }
        catch (InvalidOperationException)
        {
            return AgentStatus.NotInstalled;
        }
    }

    public void Dispose() => _timer.Stop();
}
