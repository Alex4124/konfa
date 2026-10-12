#!/usr/bin/env bash
# Deploy by hand: /srv/konfa/update.sh on the server. Runs the automatic deploy right now instead of waiting
# for the timer, and lets it try again a commit that failed before. Run as root.
since=$(date '+%F %T')
rm -f /srv/konfa/deploy/failed-sha
systemctl start konfa-autodeploy.service
result=$?
journalctl -u konfa-autodeploy.service --since "$since" --no-pager -o cat
echo "status: $(cat /srv/konfa/deploy/status 2>/dev/null || echo 'no deploy yet')"
echo "running: $(curl -fsS --max-time 5 http://127.0.0.1:8787/version.txt 2>/dev/null | head -n1)"
exit $result
