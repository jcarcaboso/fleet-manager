using System.Net;

namespace Fleet.Server.Hosting;

public static class ListenerPolicy
{
    public static void Validate(IConfiguration configuration, bool allowLoopbackHttp)
    {
        var endpoints = configuration.GetSection("Kestrel:Endpoints").GetChildren()
            .Select(x => x["Url"]).Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x!).ToArray();
        if (endpoints.Length == 0)
            endpoints = (configuration["urls"] ?? "").Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (endpoints.Length == 0) throw new InvalidOperationException("Configure explicit HTTPS URLs or Kestrel endpoints.");
        foreach (var endpoint in endpoints)
        {
            if (!Uri.TryCreate(endpoint, UriKind.Absolute, out var uri) || !string.IsNullOrEmpty(uri.UserInfo) ||
                uri.AbsolutePath != "/" || !string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment) ||
                uri.Host is "*" or "+")
                throw new InvalidOperationException("Listener URLs must contain an explicit host and port with no path or credentials.");
            var loopback = uri.Host.Equals("localhost", StringComparison.OrdinalIgnoreCase) ||
                (IPAddress.TryParse(uri.Host.Trim('[', ']'), out var address) && IPAddress.IsLoopback(address));
            if (uri.Scheme != "https" && !(uri.Scheme == "http" && allowLoopbackHttp && loopback))
                throw new InvalidOperationException("Listeners require HTTPS; the development HTTP exception is loopback-only.");
        }
    }
}
