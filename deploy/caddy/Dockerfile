# Caddy med Cloudflares DNS-modul — behövs för wildcard-certifikatet via DNS-utmaning.
# Wildcard är ett krav, inte en bekvämlighet: certifikat per värdnamn hamnar i de publika
# Certificate Transparency-loggarna och skulle röja apparnas hemliga adresser (ADR 0002).
# DNS-värden är bara DNS-värd; posterna ska vara rena DNS-poster, aldrig proxade.
ARG CADDY_VERSION=2.11.4
FROM caddy:${CADDY_VERSION}-builder AS bygg
ARG CLOUDFLARE_DNS_VERSION=v0.2.4
RUN xcaddy build --with github.com/caddy-dns/cloudflare@${CLOUDFLARE_DNS_VERSION}

FROM caddy:${CADDY_VERSION}
COPY --from=bygg /usr/bin/caddy /usr/bin/caddy
