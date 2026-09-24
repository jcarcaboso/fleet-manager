using Fleet.Server.Hosting;
using Fleet.Server.Persistence;
using Fleet.Server.Security;
using Microsoft.AspNetCore.Server.Kestrel.Https;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

var builder = WebApplication.CreateBuilder(args);
builder.AddFleetServer();
builder.WebHost.ConfigureKestrel((context, options) =>
{
    options.AddServerHeader = false;
    options.Limits.MaxConcurrentConnections = 256;
    options.Limits.MaxConcurrentUpgradedConnections = 0;
    options.Limits.MaxRequestBodySize = 16 * 1024;
    options.Limits.RequestHeadersTimeout = TimeSpan.FromSeconds(10);
    options.Limits.KeepAliveTimeout = TimeSpan.FromSeconds(30);
    options.ConfigureHttpsDefaults(https =>
    {
        https.ClientCertificateMode = ClientCertificateMode.AllowCertificate;
        https.ClientCertificateValidation = (certificate, _, _) =>
        {
            // Admit expired certificates for renewal; HTTP authentication enforces endpoint-specific validity.
            return options.ApplicationServices.GetRequiredService<NodeCertificateIssuer>().ValidateChain(certificate, allowExpired: true);
        };
    });
});
var app = builder.Build();

if (args.Contains("--migrate", StringComparer.Ordinal))
{
    using var scope = app.Services.CreateScope();
    await scope.ServiceProvider.GetRequiredService<FleetDbContext>().Database.MigrateAsync();
    return;
}

// Validate the issuing key and certificate before accepting any connections.
_ = app.Services.GetRequiredService<NodeCertificateIssuer>();
ListenerPolicy.Validate(app.Configuration, app.Services.GetRequiredService<IOptions<FleetOptions>>().Value.AllowLoopbackHttp);

app.UseFleetServer();
app.MapFleetServer();
await app.RunAsync();

public partial class Program;
