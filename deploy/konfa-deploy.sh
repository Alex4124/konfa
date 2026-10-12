#!/usr/bin/env bash
# Konfa auto-deploy. Runs as root from /usr/local/sbin/konfa-deploy, every two minutes (konfa-autodeploy.timer).
# The file in the repository is the source; the server runs its own copy, installed by hand:
#   install -m 750 deploy/konfa-deploy.sh /usr/local/sbin/konfa-deploy
# (the checkouts belong to the user the site runs as, so root never takes its own code from them unattended).
#
# When origin/master has a commit the server does not run, that commit is built in the idle one of two
# checkouts, in a unit of its own at low priority: the running site and a lesson in progress keep the CPU.
# Then the site is switched: stop, copy the database, apply new migrations, repoint /srv/konfa/current,
# start, check. If the check fails, the previous checkout is put back.
#
#   konfa-deploy                    deploy if master moved
#   konfa-deploy --force            build and switch even if master did not move or this commit failed before
#   konfa-deploy --drill-rollback   the same, but the check after the switch counts as failed
#   konfa-deploy --migrate-only CHECKOUT DATA_DIR   apply the migrations a data directory lacks, nothing else
set -euo pipefail

ROOT=/srv/konfa
SLOT_A=$ROOT/app
SLOT_B=$ROOT/app-b
CURRENT=$ROOT/current          # symlink to the checkout the site runs from
STATE=$ROOT/state              # --persist-to of the site: D1 and the files of lesson materials
BACKUPS=$ROOT/backups
VAR=$ROOT/deploy               # lock, status, failed-sha, switching
ENV_FILE=/etc/konfa/konfa.env
SERVICE=konfa
BRANCH=master
SITE=http://127.0.0.1:8787
LEDGER="CREATE TABLE IF NOT EXISTS deploy_migrations (name TEXT PRIMARY KEY NOT NULL, applied_at INTEGER NOT NULL); SELECT name FROM deploy_migrations"

drill=0
building=0
switching=0

log() { printf '%s\n' "$*"; }
die() { log "ERROR: $*"; exit 1; }
status() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >"$VAR/status"; }
as_konfa() { runuser -u konfa -- env PATH=/opt/node/bin:/usr/bin:/bin HOME=/srv/konfa CI=1 "$@"; }

# This commit is not tried again until master moves or somebody runs update.sh.
give_up() { # SHA REASON
  log "FAILED: $2"
  ((drill)) || printf '%s\n' "$1" >"$VAR/failed-sha"
  status "failed $1: $2"
  exit 1
}

on_exit() {
  ((!building)) || systemctl stop konfa-build.service 2>/dev/null || true
  ((!switching)) || systemctl start "$SERVICE" || true
}

# Fetch, install and build in a unit of its own: low CPU and IO weight, and under memory pressure
# the build is the one that swaps or dies, not LiveKit or the site.
build() { # CHECKOUT SHA
  systemctl stop konfa-build.service 2>/dev/null || true
  systemctl reset-failed konfa-build.service 2>/dev/null || true
  systemd-run --unit=konfa-build --wait --collect --pipe \
    -p User=konfa -p Group=konfa -p WorkingDirectory="$1" \
    -p Nice=15 -p CPUWeight=20 -p IOWeight=20 -p MemoryHigh=900M -p OOMScoreAdjust=800 -p RuntimeMaxSec=25min \
    -E PATH=/opt/node/bin:/usr/bin:/bin -E HOME=/srv/konfa -E CI=1 \
    /bin/bash -euc '
      [[ $(pwd -P) == "$1" ]]
      git fetch --quiet origin "$3"
      git reset --quiet --hard "$2"
      pnpm install --frozen-lockfile
      NODE_OPTIONS=--max-old-space-size=1536 node scripts/run-framework.mjs build
    ' konfa-build "$1" "$2" "$BRANCH"
}

# Everything the build output needs before it can serve; written as konfa, so the next build can delete it.
prepare() { # CHECKOUT SHA LIVE_CHECKOUT
  local file dir from to
  for file in dist/server/index.js dist/server/wrangler.json dist/server/BUILD_ID; do
    [[ -s $1/$file ]] || { log "the build left no $file"; return 1; }
  done
  [[ $(as_konfa git -C "$1" rev-parse HEAD) == "$2" ]] || { log "$1 is not at $2"; return 1; }
  as_konfa ln -sfn "$ENV_FILE" "$1/dist/server/.dev.vars" || return 1
  printf '%s\n%s\n' "$2" "$(date -u +%FT%TZ)" | as_konfa tee "$1/dist/client/version.txt" >/dev/null || return 1
  # Tabs opened before the switch still load their lazy chunks (upload, pdf.js) by the old hashed names.
  for dir in _next/static/chunks _next/static/css; do
    from=$3/dist/client/$dir
    to=$1/dist/client/$dir
    [[ -d $from && -d $to ]] || continue
    if (($(find "$from" -type f | wc -l) > 20000)); then log "NOTE: $from has too many files, old chunks not kept"; continue; fi
    as_konfa cp -a --update=none "$from/." "$to/" || log "NOTE: could not keep the old files of $dir"
    as_konfa find "$to" -type f -mtime +14 -delete || true
  done
}

# The command migrations were applied with by hand so far, from a built checkout against a data directory.
d1() { # CHECKOUT DATA_DIR ARGS...
  local checkout=$1 data=$2
  shift 2
  (cd "$checkout" && as_konfa node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js \
    d1 execute DB --local --config dist/server/wrangler.json --persist-to "$data" "$@")
}

names_from_json() {
  /opt/node/bin/node -e '
    let text = "";
    process.stdin.on("data", (chunk) => { text += chunk; }).on("end", () => {
      for (const set of JSON.parse(text.slice(text.indexOf("[")))) for (const row of set.results || []) if (row.name) console.log(row.name);
    });'
}

# True when the new checkout has migration files the running one lacks; only then is the database asked.
has_new_migrations() { # CHECKOUT LIVE_CHECKOUT
  local file
  for file in "$1"/drizzle/*.sql; do
    [[ -e $file ]] || continue
    [[ -e $2/drizzle/${file##*/} ]] || return 0
  done
  return 1
}

# Applies the drizzle/*.sql files the database has not recorded in deploy_migrations. They go in one file
# together with their ledger rows, and wrangler runs a file as one transaction: all of it or nothing.
# Nothing else may have the database open (the site is stopped, or the directory is a copy).
apply_pending() { # CHECKOUT DATA_DIR
  local applied file name sql pending=()
  applied=$(d1 "$1" "$2" --json --command "$LEDGER" | names_from_json) || { log "migrations: could not read deploy_migrations"; return 1; }
  for file in "$1"/drizzle/*.sql; do
    [[ -e $file ]] || continue
    name=${file##*/}
    [[ $name =~ ^[A-Za-z0-9_.-]+$ ]] || { log "migrations: unexpected file name $name"; return 1; }
    grep -qxF -- "$name" <<<"$applied" || pending+=("$file")
  done
  ((${#pending[@]})) || { log "migrations: nothing new"; return 0; }
  log "migrations: applying ${pending[*]##*/}"
  sql=$VAR/migrate-$$.sql
  : >"$sql" && chmod 644 "$sql" || return 1
  for file in "${pending[@]}"; do
    { cat "$file" && printf "\nINSERT INTO deploy_migrations (name, applied_at) VALUES ('%s', %s);\n" "${file##*/}" "$(date +%s)"; } >>"$sql" || { rm -f "$sql"; return 1; }
  done
  if d1 "$1" "$2" --file "$sql"; then rm -f "$sql"; return 0; fi
  rm -f "$sql"
  log "migrations: failed, nothing was applied"
  return 1
}

# New migrations meet real data first on a copy of the newest database backup, while the site still runs.
rehearse_migrations() { # CHECKOUT
  local last copy=$VAR/rehearsal result=0
  last=$(find "$BACKUPS" -maxdepth 1 -type d -name 'd1-*' | sort | tail -n1)
  [[ -n $last ]] || { log "migrations: no database copy to rehearse on"; return 0; }
  rm -rf "$copy"
  mkdir -p "$copy/v3" && cp -a "$last" "$copy/v3/d1" && chown konfa:konfa "$copy" "$copy/v3" || return 1
  log "migrations: rehearsal on a copy of $last"
  apply_pending "$1" "$copy" || result=1
  rm -rf "$copy"
  return $result
}

healthy() { # SHA — the right build serves files, the app reaches the database, the secrets are loaded
  local deadline=$((SECONDS + 90))
  while ((SECONDS < deadline)); do
    if [[ $(curl -fsS --max-time 5 "$SITE/version.txt" 2>/dev/null | head -n1) == "$1" ]] &&
      [[ $(curl -s -o /dev/null --max-time 5 -w '%{http_code}' "$SITE/api/rooms/deploy-check") == 404 ]] &&
      [[ $(curl -s -o /dev/null --max-time 5 -w '%{http_code}' -H 'Content-Type: application/json' -d '{}' "$SITE/api/rooms") == 400 ]]; then
      return 0
    fi
    sleep 2
  done
  return 1
}

point_current() { rm -f "$CURRENT.new" && ln -s "$1" "$CURRENT.new" && mv -T "$CURRENT.new" "$CURRENT"; }

# The only part during which the site is down.
switch() { # CHECKOUT SHA BACKUP_DIR MIGRATE
  systemctl stop "$SERVICE" || return 1
  cp -a "$STATE/v3/d1" "$3" || return 1
  if (($4)); then apply_pending "$1" "$STATE" || return 1; fi
  point_current "$1" || return 1
  [[ -z $(find "$STATE" ! -user konfa -print -quit) ]] || { log "$STATE has files that do not belong to konfa"; return 1; }
  systemctl start "$SERVICE" || return 1
  healthy "$2"
}

# Migrations only add, and the previous version works with them (README), so the database stays as it is.
# Only if the previous version fails as well does the copy taken at the switch come back, as a whole directory.
rollback() { # CHECKOUT SHA BACKUP_DIR
  log "rollback: back to $1"
  systemctl stop "$SERVICE" || true
  point_current "$1" || return 1
  systemctl start "$SERVICE" || return 1
  if healthy "$2"; then return 0; fi
  [[ -d $3 ]] || return 1
  log "rollback: the previous version fails the check too, putting back the database copy $3"
  systemctl stop "$SERVICE" || true
  mv "$STATE/v3/d1" "$BACKUPS/replaced-${3##*/}" && cp -a "$3" "$STATE/v3/d1" || return 1
  systemctl start "$SERVICE" || return 1
  healthy "$2"
}

# The LibreOffice converter (materials) runs from its own copy: its sandbox cannot read /srv/konfa.
converter() { # CHECKOUT
  local changed=0
  if ! cmp -s "$1/deploy/konfa-convert.service" /etc/systemd/system/konfa-convert.service; then
    install -m 644 "$1/deploy/konfa-convert.service" /etc/systemd/system/konfa-convert.service || return 1
    systemctl daemon-reload || return 1
    changed=1
  fi
  if ! cmp -s "$1/services/convert/server.mjs" /opt/konfa-convert/server.mjs; then
    install -m 644 "$1/services/convert/server.mjs" /opt/konfa-convert/server.mjs || return 1
    changed=1
  fi
  ((!changed)) || systemctl restart konfa-convert
}

main() {
  local force=0
  case ${1:-} in
    "") ;;
    --force) force=1 ;;
    --drill-rollback) force=1 drill=1 ;;
    --migrate-only)
      [[ $# == 3 ]] || die "usage: konfa-deploy --migrate-only CHECKOUT DATA_DIR"
      mkdir -p "$VAR"
      apply_pending "$2" "$3"
      return
      ;;
    *) die "usage: konfa-deploy [--force | --drill-rollback | --migrate-only CHECKOUT DATA_DIR]" ;;
  esac

  mkdir -p "$VAR" "$BACKUPS"
  exec 9>"$VAR/lock"
  flock -n 9 || exit 0
  trap on_exit EXIT
  trap 'exit 143' TERM INT HUP

  if [[ -e $VAR/switching ]]; then
    log "the previous run ended in the middle of a switch: starting $SERVICE"
    systemctl start "$SERVICE" || true
    rm -f "$VAR/switching"
  fi

  local live idle live_sha new_sha pid cwd
  live=$(readlink -f "$CURRENT")
  case $live in
    "$SLOT_A") idle=$SLOT_B ;;
    "$SLOT_B") idle=$SLOT_A ;;
    *) die "$CURRENT points to '$live', expected $SLOT_A or $SLOT_B" ;;
  esac
  live_sha=$(as_konfa git -C "$live" rev-parse HEAD)
  new_sha=$(as_konfa timeout 30 git -C "$live" ls-remote origin "refs/heads/$BRANCH" 2>/dev/null | cut -f1) || exit 0
  [[ $new_sha =~ ^[0-9a-f]{40}$ ]] || exit 0
  if ((!force)); then
    [[ $new_sha != "$live_sha" ]] || exit 0
    [[ ! -f $VAR/failed-sha || $(<"$VAR/failed-sha") != "$new_sha" ]] || exit 0
  fi

  pid=$(systemctl show -p MainPID --value "$SERVICE")
  if [[ $pid != 0 ]]; then
    cwd=$(readlink -f "/proc/$pid/cwd")
    [[ $cwd == "$live" ]] || die "$SERVICE runs from $cwd, but $CURRENT points to $live"
  fi

  log "deploying $new_sha: the site runs $live_sha from $live, building in $idle"
  building=1
  build "$idle" "$new_sha" || give_up "$new_sha" "the build failed; the site was not touched"
  building=0
  prepare "$idle" "$new_sha" "$live" || give_up "$new_sha" "the build output is not usable; the site was not touched"

  local migrate=0
  if has_new_migrations "$idle" "$live"; then
    migrate=1
    rehearse_migrations "$idle" || give_up "$new_sha" "the new migrations fail on a copy of the database; the site was not touched"
  fi
  (($(df --output=avail -k "$ROOT" | tail -n1) >= 1048576)) || give_up "$new_sha" "less than 1 GB of disk left; the site was not touched"

  local backup started switched=0
  backup=$BACKUPS/d1-$(date -u +%Y%m%d-%H%M%S)
  started=$SECONDS
  touch "$VAR/switching"
  switching=1
  log "switching to $idle"
  if switch "$idle" "$new_sha" "$backup" "$migrate"; then
    if ((drill)); then log "drill: the check passed, taking it as failed"; else switched=1; fi
  fi
  if ((!switched)); then
    if rollback "$live" "$live_sha" "$backup"; then
      switching=0
      rm -f "$VAR/switching"
      give_up "$new_sha" "the new version did not pass the check; $live_sha runs again from $live ($((SECONDS - started)) s)"
    fi
    switching=0
    rm -f "$VAR/switching"
    give_up "$new_sha" "neither the new nor the previous version passes the check: $SERVICE needs a person"
  fi
  switching=0
  rm -f "$VAR/switching" "$VAR/failed-sha"
  status "ok $new_sha"
  log "done: $new_sha runs from $idle, the switch took $((SECONDS - started)) s"

  converter "$idle" || log "NOTE: the converter was not updated"
  find "$BACKUPS" -maxdepth 1 -type d -name 'd1-*' | sort | head -n -10 | xargs -r rm -rf --
  cmp -s "$idle/deploy/konfa-deploy.sh" "$0" || log "NOTE: deploy/konfa-deploy.sh in the repository differs from $0; install it by hand"
  local unit
  for unit in konfa-autodeploy.service konfa-autodeploy.timer; do
    cmp -s "$idle/deploy/$unit" "/etc/systemd/system/$unit" || log "NOTE: deploy/$unit in the repository differs from the installed one"
  done
}

main "$@"
