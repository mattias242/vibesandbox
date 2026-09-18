# Testavbild för infra/-skripten: en engångsvärd som liknar den riktiga (Debian 13 med sshd,
# nftables och cloud-init) men utan systemd. Byggs av kor-tester.sh; containrarna körs med --rm.
ARG BAS=debian:13
FROM ${BAS}
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      bash ca-certificates curl gnupg openssl sudo passwd openssh-server nftables iproute2 \
      procps jq shellcheck cloud-init python3 xfsprogs uidmap \
 && apt-get clean \
 && mkdir -p /run/sshd
