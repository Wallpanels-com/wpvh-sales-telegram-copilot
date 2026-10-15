FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node --from=build /app/migrations ./migrations
USER node
CMD ["sh", "-c", "node dist/scripts/migrate.js && node dist/scripts/seed-sales.js && node dist/src/index.js"]
