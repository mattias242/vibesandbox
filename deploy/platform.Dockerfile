# Plattformens avbild. Byggs från repots rot: docker build -f deploy/platform.Dockerfile .
# Samma avbild kör plattformen och egress-proxyn (olika kommando i compose.yml).
FROM node:24-slim AS bygg
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages
# Installationsskript körs aldrig — samma regel som för appmallens beroenden (ADR 0001).
RUN npm ci --ignore-scripts
# Byggverktygets webbgränssnitt (när paketet finns) och appmallens exempelbygge, som lokala
# provkörningar publicerar.
RUN if [ -d apps/builder-ui ]; then npm run build -w @vibesandbox/builder-ui; fi \
 && npm run build -w @vibesandbox/app-template

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=bygg /app /app
# Monteringspunkterna ägs av plattformens uid, så att en ny namngiven volym ärver rätt ägare.
# (På servern är /data en bindmontering som provision.sh redan har gett rätt ägare.)
RUN mkdir -p /data /jobs && chown 10001:10001 /data /jobs
# uid 10001 i containern; under userns-remap blir det 110001 på värden (se infra/README.md).
USER 10001:10001
CMD ["node", "apps/platform/src/main.ts"]
