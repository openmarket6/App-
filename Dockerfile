# Container image for the API and the worker.
#
# Render builds from source without this, so it is here for portability: the
# same image runs on AWS ECS/Fargate, Fly, or anywhere else, which keeps a
# future move a deployment change rather than a rewrite.
#
# Multi-stage so build tooling and dev dependencies never reach the runtime
# image -- smaller to ship and less to attack.

FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
# Migrations are read at runtime by `npm run migrate`.
COPY db ./db

# Run as a non-root user. The node image ships one; a process that does not
# need root should not have it.
USER node

EXPOSE 8080

# Which entry point runs is chosen by the platform:
#   API:    node dist/index.js   (the default below)
#   Worker: node dist/worker.js
CMD ["node", "dist/index.js"]
