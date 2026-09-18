#!/usr/bin/env bash
# Genererar ett självsignerat cert med SAN för alla värdnamn spiken använder.
# Privata nyckeln hamnar i certs/ som är gitignorerad – får ALDRIG committas.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout certs/key.pem -out certs/cert.pem -days 30 \
  -subj "/CN=vibesandbox-spike" \
  -addext "subjectAltName=DNS:localhost,DNS:demo.localtest.me,DNS:demo--c.localtest.me,DNS:*.localtest.me,DNS:bygg.lvh.me,DNS:login.lvh.me,DNS:p-demo.lvh.me,DNS:*.lvh.me,DNS:evil.127.0.0.1.nip.io,IP:127.0.0.1"
echo "Cert skapat i certs/ (SAN: se ovan)"
