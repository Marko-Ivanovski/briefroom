# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS build
ENV HUSKY=0 CI=true
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm fetch
COPY . .
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --offline
# No VITE_BRIEFROOM_TESTKIT here: the web bundle must carry no testkit code.
RUN pnpm --filter @briefroom/api --filter @briefroom/worker --filter @briefroom/web build
# The api and worker bundles keep node_modules imports external. The worker imports a subset of
# the api's dependencies, so one production install serves both.
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm --filter @briefroom/api deploy --prod /out

# Tunnel binaries for remote access. Bumping a version means replacing both of its checksums,
# from pkgs.tailscale.com/stable/<file>.tgz.sha256 and from the cloudflared release notes.
FROM node:24-bookworm-slim AS tunnels
ARG TARGETARCH
ARG TAILSCALE_VERSION=1.104.7
ARG CLOUDFLARED_VERSION=2026.11.0
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) ts_sha=e56693ff74a64f2591b7e819c280635a100aae1ddfb0ef058fcd052b7cd8d16c; \
             cf_sha=51f7c68b57ed7269164075d7e789efce5b59355982f06392deeb037d982a51fd ;; \
      arm64) ts_sha=d6bed2720310b328b861f943d7b4016c5358a9bad60575eb51e8143b79068484; \
             cf_sha=abe54a006acf9faf2d19ee9d953cb0d0804e92f59c5382a162e57b84d086f56f ;; \
      *) echo "No pinned tunnel binaries for architecture '$TARGETARCH'" >&2; exit 1 ;; \
    esac; \
    ts_dir="/tmp/tailscale_${TAILSCALE_VERSION}_${TARGETARCH}"; \
    mkdir -p /out; \
    curl -fsSLo /tmp/tailscale.tgz \
      "https://pkgs.tailscale.com/stable/tailscale_${TAILSCALE_VERSION}_${TARGETARCH}.tgz"; \
    echo "$ts_sha  /tmp/tailscale.tgz" | sha256sum -c -; \
    tar -xzf /tmp/tailscale.tgz -C /tmp; \
    install -m 0755 "$ts_dir/tailscale" "$ts_dir/tailscaled" /out/; \
    curl -fsSLo /tmp/cloudflared \
      "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${TARGETARCH}"; \
    echo "$cf_sha  /tmp/cloudflared" | sha256sum -c -; \
    install -m 0755 /tmp/cloudflared /out/cloudflared

FROM node:24-bookworm-slim
ARG VERSION=0.0.0
ENV NODE_ENV=production \
    BRIEFROOM_VERSION=${VERSION} \
    BRIEFROOM_DATA_DIR=/data \
    BRIEFROOM_WEB_DIR=/app/apps/web/dist \
    HOST=0.0.0.0 \
    PORT=4300
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/api/dist ./apps/api/dist
COPY --from=build /repo/apps/worker/dist ./apps/worker/dist
COPY --from=build /repo/apps/web/dist ./apps/web/dist
# The bundled db package looks for its migrations one folder above the bundle, at apps/api/migrations.
COPY --from=build /repo/packages/db/migrations ./apps/api/migrations
COPY --from=tunnels /out/ /usr/local/bin/
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/entrypoint.sh
# tailscaled runs in userspace networking as this same non-root user, with its state in /data/tailscale.
RUN mkdir /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 4300
ENTRYPOINT ["entrypoint.sh"]
CMD ["node", "apps/api/dist/main.js"]
