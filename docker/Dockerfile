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
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN mkdir /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 4300
ENTRYPOINT ["entrypoint.sh"]
CMD ["node", "apps/api/dist/main.js"]
