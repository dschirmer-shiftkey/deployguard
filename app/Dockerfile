# Build context must be the repo root: docker build -f app/Dockerfile .
FROM node:20-slim AS build
WORKDIR /app
COPY app/package.json app/package-lock.json* ./
RUN npm ci
COPY app/tsconfig.json ./
COPY src/risk-engine.ts src/risk-engine.ts
COPY app/src/ src/
RUN npx tsc

FROM node:20-slim
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=build /app/dist/ dist/
EXPOSE 3000
CMD ["node", "dist/server.js"]
