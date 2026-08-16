# Debian slim + the chromium matching the pinned playwright npm version.
# (Smaller/more reliable than the full mcr.microsoft.com/playwright base, and no
# browser/version mismatch.)
FROM node:20-bookworm-slim AS builder
WORKDIR /build
COPY package*.json ./
RUN npm install
COPY src ./src
COPY tsconfig.json ./
RUN npm run build
RUN npm prune --production

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/dist ./dist
# Install ONLY chromium (matching the pinned playwright version) + its system deps.
RUN npx playwright install --with-deps chromium
EXPOSE 3000
CMD ["node", "dist/index.js"]
