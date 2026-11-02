#!/bin/sh
set -eu
# Invocation: sh install-release.sh RELEASE_ID ARCHIVE ENV_FILE
release_id=$1
archive=$2
env_file=$3
case "$release_id" in *[!a-zA-Z0-9_-]*|'') echo 'Invalid release ID' >&2; exit 1;; esac
release_dir="/opt/agent-relay/releases/$release_id"
if [ -e "$release_dir" ]; then echo 'Release already exists; use a fresh ID' >&2; exit 1; fi
sudo -n install -d -o ubuntu -g ubuntu -m 0755 /opt/agent-relay /opt/agent-relay/releases "$release_dir"
sudo -n install -d -o ubuntu -g ubuntu -m 0700 /var/lib/agent-relay
tar -xzf "$archive" -C "$release_dir"
cd "$release_dir"
PATH=/opt/agent-relay-runtime/bin:$PATH /opt/agent-relay-runtime/bin/npm ci --omit=dev --ignore-scripts --no-audit --no-fund
sudo -n install -o root -g root -m 0600 "$env_file" /etc/agent-relay.env
sudo -n ln -sfn "$release_dir" /opt/agent-relay/current
sudo -n install -m 0644 deploy/agent-relay.service /etc/systemd/system/agent-relay.service
sudo -n install -m 0644 deploy/nginx-ip.conf /etc/nginx/sites-available/agent-relay
sudo -n install -m 0644 deploy/nginx-upgrade.conf /etc/nginx/conf.d/agent-relay-upgrade.conf
sudo -n ln -sfn /etc/nginx/sites-available/agent-relay /etc/nginx/sites-enabled/agent-relay
sudo -n install -m 0644 deploy/agent-relay-ip-renew.service /etc/systemd/system/agent-relay-ip-renew.service
sudo -n install -m 0644 deploy/agent-relay-ip-renew.timer /etc/systemd/system/agent-relay-ip-renew.timer
sudo -n nginx -t
sudo -n systemctl daemon-reload
sudo -n systemctl enable --now agent-relay.service agent-relay-ip-renew.timer
sudo -n systemctl restart agent-relay.service
sudo -n systemctl reload nginx.service
systemctl is-active agent-relay.service nginx.service
curl --retry 10 --retry-delay 1 --retry-connrefused -fsS http://127.0.0.1:8787/healthz
