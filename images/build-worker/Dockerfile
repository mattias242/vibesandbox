# syntax=docker/dockerfile:1
#
# Byggavbilden: här byggs AI-genererad appkod. Opålitlig kod — avbilden innehåller därför bara
# det bygget behöver (mallen, SDK:t, kontrakten, policyn och byggkedjan) och inga hemligheter.
#
#   npm run image -w @vibesandbox/build                              # värdens arkitektur
#   npm run image -w @vibesandbox/build -- --platform linux/amd64    # för servern, även från en Mac
#
# Två sätt att köra den (se packages/build/README.md):
#   - drivrutinen `docker`: en engångscontainer per bygge (standardkommandot nedan)
#   - drivrutinen `spool`: en långlivad byggarbetare, kommando `node images/build-worker/spool-worker.ts`
#
# Kontexten är repots rot; Dockerfile.dockerignore bredvid den här filen avgör vad som skickas med.

# Pinnad på index-sammanfattning (alla arkitekturer), så att samma Dockerfile ger samma bas.
FROM node:24-slim@sha256:a9d7043680f11d1229c0db1900b7f916719b1f0e4b47ed14a8c881e99767b8d2

WORKDIR /opt/vibesandbox

# Beroenden först (eget lager, byggs bara om när manifesten ändras). Låsfilen gäller hela repot;
# bara de arbetsytor bygget behöver finns med, och bara deras beroenden installeras.
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/sdk/package.json packages/sdk/
COPY packages/app-template/package.json packages/app-template/
COPY packages/policy/package.json packages/policy/
COPY packages/build/package.json packages/build/
# Installationsskript körs aldrig (ADR 0001). Paket hämtas bara här, när avbilden byggs —
# själva byggena körs utan nät.
RUN npm ci --ignore-scripts --no-audit --no-fund \
      -w @vibesandbox/contracts -w @vibesandbox/sdk -w @vibesandbox/app-template \
      -w @vibesandbox/policy -w @vibesandbox/build \
 && npm cache clean --force

COPY packages/contracts/src packages/contracts/src
COPY packages/sdk/src packages/sdk/src
COPY packages/app-template/index.html packages/app-template/vite.config.ts packages/app-template/tsconfig.json packages/app-template/approved-packages.json packages/app-template/
COPY packages/app-template/src packages/app-template/src
COPY packages/app-template/starter packages/app-template/starter
COPY packages/policy/src packages/policy/src
COPY packages/build/src packages/build/src
COPY images/build-worker/entrypoint.ts images/build-worker/spool-worker.ts images/build-worker/

# Allt ovan ägs av root och är skrivskyddat för byggets användare. Containern körs dessutom med
# --read-only; bara /work, /tmp och /out (docker) respektive jobbkatalogen (spool) är skrivbara.
ENV NODE_ENV=production
USER 10001:10001
CMD ["node", "images/build-worker/entrypoint.ts"]
