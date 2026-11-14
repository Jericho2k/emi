FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

# Runtime dependencies only. The source runs through tsx, so there is no build step.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY migrations ./migrations
COPY src ./src
COPY tsconfig.json ./

USER node
CMD ["node_modules/.bin/tsx", "src/index.ts"]
