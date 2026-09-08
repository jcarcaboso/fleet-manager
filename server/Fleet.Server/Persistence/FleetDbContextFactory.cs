using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

namespace Fleet.Server.Persistence;

public sealed class FleetDbContextFactory : IDesignTimeDbContextFactory<FleetDbContext>
{
    public FleetDbContext CreateDbContext(string[] args)
    {
        var options = new DbContextOptionsBuilder<FleetDbContext>()
            .UseNpgsql("Host=localhost;Database=fleet_design;Username=fleet;Password=fleet")
            .Options;
        return new(options);
    }
}
