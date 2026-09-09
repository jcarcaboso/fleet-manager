FROM mcr.microsoft.com/dotnet/sdk:10.0.302-noble@sha256:72dd743782f2ae7e5476fd64f6a460045e3998dc862218b80e6944cba79a01b0 AS build
WORKDIR /src
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
COPY global.json Directory.Build.props ./
COPY server/Fleet.Core/Fleet.Core.csproj server/Fleet.Core/packages.lock.json server/Fleet.Core/
COPY server/Fleet.Server/Fleet.Server.csproj server/Fleet.Server/packages.lock.json server/Fleet.Server/
RUN dotnet restore server/Fleet.Server/Fleet.Server.csproj --locked-mode
COPY server/Fleet.Core/ server/Fleet.Core/
COPY server/Fleet.Server/ server/Fleet.Server/
RUN dotnet publish server/Fleet.Server/Fleet.Server.csproj -c Release --no-restore -o /out /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:10.0.11-noble@sha256:011bb5f30180717b1c8b65822ff2c99bcb96bc65af0164589751b83c7b4949f7 AS runtime
USER root
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/lib/fleet /home/app/.ssh \
    && chown -R app:app /var/lib/fleet /home/app
WORKDIR /app
COPY --from=build /out/ ./
COPY LICENSE ./LICENSE
ENV ASPNETCORE_URLS=https://0.0.0.0:7443 \
    ASPNETCORE_ENVIRONMENT=Production \
    DOTNET_EnableDiagnostics=0 \
    HOME=/home/app
LABEL org.opencontainers.image.title="Fleet Manager Server" \
      org.opencontainers.image.description="Self-hosted Skill distribution server. Requires PostgreSQL and mounted TLS configuration." \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="0.4.1"
USER app
EXPOSE 7443
ENTRYPOINT ["dotnet", "Fleet.Server.dll"]
