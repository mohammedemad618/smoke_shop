#!/usr/bin/env bash
# pos-certbot: certbot on the POS's own folders only (docs/ops-runbook.md). Installed as
# /usr/local/sbin/pos-certbot (root:root 0700), so the same command works in every SSH
# session. Run as root:
#
#   pos-certbot renew --dry-run                         every POS certificate, against staging
#   pos-certbot renew --dry-run --cert-name <host>      one of them
#   pos-certbot certificates                            what the POS's certbot holds
#
# Plain `certbot` works on /etc/letsencrypt instead: niura's, smoke's and the other sites'
# certificates, with niura's renewal hooks (an nginx reload). Never use it for the POS.
set -euo pipefail

exec /usr/bin/certbot --config-dir /etc/letsencrypt-pos --work-dir /var/lib/letsencrypt-pos --logs-dir /var/log/letsencrypt-pos "$@"
