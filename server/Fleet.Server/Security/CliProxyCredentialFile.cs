using System.Text;

namespace Fleet.Server.Security;

internal static class CliProxyCredentialFile
{
    private const int MaximumBytes = 4_096;

    public static async Task<byte[]?> ReadAsync(string path, CancellationToken cancellationToken)
    {
        if (string.IsNullOrEmpty(path)) return null;
        try
        {
            var file = new FileInfo(path);
            if (!file.Exists || file.LinkTarget is not null || (file.Attributes & FileAttributes.Directory) != 0 ||
                file.Length is <= 0 or > MaximumBytes)
                return null;
            if (!OperatingSystem.IsWindows())
            {
                var mode = File.GetUnixFileMode(path);
                const UnixFileMode shared = UnixFileMode.GroupRead | UnixFileMode.GroupWrite | UnixFileMode.GroupExecute |
                                            UnixFileMode.OtherRead | UnixFileMode.OtherWrite | UnixFileMode.OtherExecute;
                if ((mode & shared) != 0) return null;
            }
            await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read,
                bufferSize: 512, FileOptions.Asynchronous | FileOptions.SequentialScan);
            if (stream.Length is <= 0 or > MaximumBytes) return null;
            var bytes = new byte[stream.Length];
            await stream.ReadExactlyAsync(bytes, cancellationToken);
            var value = Encoding.UTF8.GetString(bytes).TrimEnd('\r', '\n');
            if (value.Length == 0 || value.Any(character => character is < '!' or > '~')) return null;
            return Encoding.UTF8.GetBytes(value);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or DecoderFallbackException)
        {
            return null;
        }
    }
}
