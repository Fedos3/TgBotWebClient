FROM node:22 AS frontend-build

WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend ./
ENV APP_ENV=production
ENV APP_BOT_PANEL=1
RUN npm run build:panel

FROM node:22-alpine AS backend-deps

WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev || npm install --omit=dev

FROM node:22-alpine

WORKDIR /app/backend

COPY --from=backend-deps /app/backend/node_modules ./node_modules
COPY backend/package.json backend/package-lock.json ./
COPY backend/src ./src
COPY backend/public ./public
COPY --from=frontend-build /app/frontend/dist ./frontend-dist

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/data/data.sqlite
ENV FRONTEND_DIST=frontend-dist

EXPOSE 3000

VOLUME ["/data"]

CMD ["node", "--no-warnings", "src/index.js"]
