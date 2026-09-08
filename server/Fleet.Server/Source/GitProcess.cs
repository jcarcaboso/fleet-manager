using System.Diagnostics;

namespace Fleet.Server.Source;

internal sealed class GitProcess
{
    public async Task<byte[]> RunAsync(
        string repository,
        IReadOnlyList<string> arguments,
        CancellationToken cancellationToken,
        long maxOutputBytes = 16 * 1024 * 1024,
        TimeSpan? timeout = null)
    {
        var start = new ProcessStartInfo("git")
        {
            WorkingDirectory = repository,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (var key in start.Environment.Keys.Where(x => x.StartsWith("GIT_", StringComparison.Ordinal)).ToArray())
            start.Environment.Remove(key);
        foreach (var argument in arguments)
            start.ArgumentList.Add(argument);
        start.Environment["GIT_TERMINAL_PROMPT"] = "0";
        start.Environment["GIT_ASKPASS"] = "";
        start.Environment["GIT_SSH_COMMAND"] = "ssh -oBatchMode=yes";
        start.Environment["GIT_CONFIG_NOSYSTEM"] = "1";
        start.Environment["GIT_CONFIG_GLOBAL"] = "/dev/null";
        start.Environment["GIT_NO_REPLACE_OBJECTS"] = "1";

        using var process = new Process { StartInfo = start };
        process.Start();
        await using var output = new MemoryStream();
        using var timeoutSource = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutSource.CancelAfter(timeout ?? TimeSpan.FromSeconds(30));
        var stdout = CopyBoundedAsync(process.StandardOutput.BaseStream, output, maxOutputBytes, timeoutSource.Token);
        var stderr = DrainBoundedAsync(process.StandardError.BaseStream, 512, timeoutSource.Token);
        try
        {
            var exited = process.WaitForExitAsync(timeoutSource.Token);
            var first = await Task.WhenAny(stdout, exited);
            await first;
            await Task.WhenAll(stdout, stderr, exited);
        }
        catch (OperationCanceledException)
        {
            await TerminateAsync(process, stdout, stderr);
            if (cancellationToken.IsCancellationRequested) throw;
            throw new GitSourceException($"git {CommandName(arguments)} exceeded its time limit.");
        }
        catch
        {
            await TerminateAsync(process, stdout, stderr);
            throw;
        }
        if (process.ExitCode != 0)
            throw new GitSourceException($"git {CommandName(arguments)} failed with exit code {process.ExitCode}.");
        return output.ToArray();
    }

    private static async Task CopyBoundedAsync(Stream source, Stream destination, long limit, CancellationToken cancellationToken)
    {
        var buffer = new byte[81920];
        long total = 0;
        int read;
        while ((read = await source.ReadAsync(buffer, cancellationToken)) != 0)
        {
            total += read;
            if (total > limit) throw new GitSourceException("git output exceeded its configured byte limit.");
            await destination.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
        }
    }

    private static async Task DrainBoundedAsync(Stream source, int retainedBytes, CancellationToken cancellationToken)
    {
        var buffer = new byte[Math.Max(1, retainedBytes)];
        while (await source.ReadAsync(buffer, cancellationToken) != 0) { }
    }

    private static async Task TerminateAsync(Process process, params Task[] readers)
    {
        try { if (!process.HasExited) process.Kill(entireProcessTree: true); }
        catch (InvalidOperationException) { }
        try { await process.WaitForExitAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(5)); }
        catch (Exception) { }
        try { await Task.WhenAll(readers).WaitAsync(TimeSpan.FromSeconds(1)); }
        catch (Exception) { }
    }

    private static string CommandName(IReadOnlyList<string> arguments)
    {
        var index = 0;
        while (index + 1 < arguments.Count && arguments[index] == "-c") index += 2;
        return index < arguments.Count ? arguments[index] : "command";
    }
}

public sealed class GitSourceException(string message) : Exception(message);
