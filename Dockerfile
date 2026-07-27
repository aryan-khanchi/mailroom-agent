FROM node:20-bookworm-slim

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src

ENV PORT=8080
# TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are set at deploy time (Koyeb env
# vars / .env locally) - no local disk or volume is required, since state
# lives in Turso rather than the container's filesystem.

EXPOSE 8080
CMD ["node", "src/server.js"]
