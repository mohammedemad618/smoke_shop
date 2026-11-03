#!/usr/bin/env bash
# pos-fingerprint: how the server's other sites look from outside, to compare before and
# after a POS change (docs/ops-runbook.md). Read-only; run as root on the server.
#
#   pos-fingerprint > /root/pos-fp-before.txt
#   ... the change ...
#   pos-fingerprint > /root/pos-fp-after.txt
#   diff /root/pos-fp-before.txt /root/pos-fp-after.txt     (no output: nothing changed)
#
# One line per host: the HTTP status on port 80 (with the redirect target), the HTTPS status
# of / and the SHA-256 fingerprint of the certificate served for the name (asked of this
# server, 127.0.0.1, not through DNS). Then the sha256sum of every nginx file that is not the
# POS's own, so a change to niura's or any other site's file shows up.
set -uo pipefail
export LC_ALL=C

DOMAIN=108-61-190-4.sslip.io
HOSTS=(hishin api.hishin admin.hishin media.hishin lapsa admin.lapsa store.lapsa sales urgold erp smoke)
NAMES=()
for h in "${HOSTS[@]}"; do NAMES+=("$h.$DOMAIN"); done
# One company host of niura's *.erp and *.sites, taken from its certificate folders
for pattern in "*.erp.$DOMAIN" "*.sites.$DOMAIN"; do
  first=$(find /etc/nginx/niura-certs -mindepth 1 -maxdepth 1 -type d -name "$pattern" -printf '%f\n' 2>/dev/null | sort | head -n 1)
  [[ -n $first ]] && NAMES+=("$first")
done

echo "# hosts: name, http status -> redirect, https status, certificate sha256"
for name in "${NAMES[@]}"; do
  http=$(curl -s -o /dev/null -w '%{http_code}->%{redirect_url}' --max-time 10 --resolve "$name:80:127.0.0.1" "http://$name/" 2>/dev/null || echo ERR)
  https=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$name:443:127.0.0.1" "https://$name/" 2>/dev/null || echo ERR)
  cert=$(timeout 10 openssl s_client -connect 127.0.0.1:443 -servername "$name" </dev/null 2>/dev/null \
    | openssl x509 -noout -fingerprint -sha256 2>/dev/null | cut -d= -f2)
  printf '%-50s %-60s %s %s\n' "$name" "$http" "$https" "${cert:-NO-CERTIFICATE}"
done

echo "# sites-enabled links"
find /etc/nginx/sites-enabled -mindepth 1 -maxdepth 1 ! -name pos -printf '%f -> %l\n' | sort

echo "# nginx files (the POS's own left out)"
find /etc/nginx -type f \
  ! -path '/etc/nginx/pos-certs/*' \
  ! -path '/etc/nginx/sites-available/pos' \
  ! -path '/etc/nginx/snippets/pos-proxy.conf' \
  ! -name '.htpasswd-pos*' \
  -print0 | sort -z | xargs -0 sha256sum
