using System.Data.Common;
using Microsoft.EntityFrameworkCore.Diagnostics;

namespace Fleet.Server.Hosting;

public sealed class DatabaseMetricsInterceptor(FleetMetrics metrics) : DbCommandInterceptor
{
    public override ValueTask<DbDataReader> ReaderExecutedAsync(DbCommand command, CommandExecutedEventData eventData,
        DbDataReader result, CancellationToken cancellationToken = default)
    {
        metrics.RecordDatabase(eventData.Duration, false);
        return ValueTask.FromResult(result);
    }

    public override ValueTask<int> NonQueryExecutedAsync(DbCommand command, CommandExecutedEventData eventData,
        int result, CancellationToken cancellationToken = default)
    {
        metrics.RecordDatabase(eventData.Duration, false);
        return ValueTask.FromResult(result);
    }

    public override ValueTask<object?> ScalarExecutedAsync(DbCommand command, CommandExecutedEventData eventData,
        object? result, CancellationToken cancellationToken = default)
    {
        metrics.RecordDatabase(eventData.Duration, false);
        return ValueTask.FromResult(result);
    }

    public override Task CommandFailedAsync(DbCommand command, CommandErrorEventData eventData, CancellationToken cancellationToken = default)
    {
        metrics.RecordDatabase(eventData.Duration, true);
        return Task.CompletedTask;
    }
}
