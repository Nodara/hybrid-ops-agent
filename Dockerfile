# better-sqlite3 is a native module; the build stage needs a toolchain.
FROM node:22-bookworm-slim AS build
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install

COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN npm run build \
  && npm prune --omit=dev

# --- dev image: hot-reload via `nest start --watch` ---
# Keeps devDependencies (the Nest CLI) and does NOT build/prune. At runtime the
# compose dev overlay bind-mounts your source over /app/src so edits reload live.
FROM node:22-bookworm-slim AS dev
WORKDIR /app
# procps provides `ps`, which nest --watch (via tree-kill) shells out to when
# restarting the process after a file change. Without it: spawn ps ENOENT.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ procps \
  && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm install
COPY tsconfig*.json nest-cli.json ./
COPY src ./src
EXPOSE 3000
CMD ["npm", "run", "start:dev"]

# --- runtime image ---
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

RUN mkdir -p /app/data
EXPOSE 3000
CMD ["node", "dist/main.js"]
