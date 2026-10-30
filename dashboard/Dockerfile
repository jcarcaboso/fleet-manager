# Build from the repository root with BuildKit (the default): docker build -f dashboard/Dockerfile .
# BuildKit applies dashboard/Dockerfile.dockerignore instead of the root .dockerignore, which only admits the Server.
FROM node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS build
WORKDIR /src/dashboard
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false
COPY dashboard/package.json dashboard/package-lock.json ./
RUN npm ci
COPY dashboard/ ./
RUN npm run build \
    && find dist -name '.*' -not -name . -prune -exec rm -rf {} + \
    && find dist -type d -exec chmod 0755 {} + \
    && find dist -type f -exec chmod 0644 {} +

FROM nginxinc/nginx-unprivileged:1.30.6-alpine3.24@sha256:f5116ed4606f3eb015dd4a8e28cb9b351476dc0ad4bc6e9f93b19cec130cdf03 AS runtime
USER root
# Replace the stock entrypoint, scripts and sample site: this image has one configuration and one start-up script.
RUN rm -rf /docker-entrypoint.sh /docker-entrypoint.d /etc/nginx/conf.d /usr/share/nginx/html \
    && mkdir -p /srv/dashboard /usr/share/licenses/fleet-dashboard
COPY --chown=root:root --chmod=0644 dashboard/nginx/nginx.conf dashboard/nginx/security-headers.conf /etc/nginx/
COPY --chown=root:root --chmod=0755 dashboard/nginx/entrypoint.sh /usr/local/bin/fleet-dashboard-entrypoint
COPY --chown=root:root --chmod=0644 LICENSE /usr/share/licenses/fleet-dashboard/LICENSE
COPY --from=build --chown=root:root /src/dashboard/dist/ /srv/dashboard/
ENV FLEET_API_ORIGIN=
LABEL org.opencontainers.image.title="Fleet Manager Dashboard" \
      org.opencontainers.image.description="Fleet Manager Operator dashboard served by nginx over HTTPS. Requires its own TLS certificate and key in /run/dashboard-tls and FLEET_API_ORIGIN." \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/jcarcaboso/fleet-manager" \
      org.opencontainers.image.url="https://github.com/jcarcaboso/fleet-manager" \
      org.opencontainers.image.version="0.12.2"
# Not the Server's uid (1654): the dashboard owns only the 0600 files in its own dashboard-tls volume.
USER 1655:1655
EXPOSE 8443
ENTRYPOINT ["/usr/local/bin/fleet-dashboard-entrypoint"]
CMD ["nginx", "-g", "daemon off;"]
