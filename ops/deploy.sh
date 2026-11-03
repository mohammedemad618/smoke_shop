#!/usr/bin/env bash
# pos-deploy: deploy or roll back the POS app on the server (installed by hand as
# /usr/local/sbin/pos-deploy; docs/ops-runbook.md). Run as root.
#
#   pos-deploy deploy [REF] [--no-sha-check]   REF: a branch of the GitHub repo (default main) or a commit
#   pos-deploy rollback [SHA]                  back to the release before (or to SHA)
#   pos-deploy status                          current release, releases kept, /readyz
#
# A deploy: git fetch in /srv/pos/repo (a bare clone), git archive <sha> into
# /srv/pos/releases/<sha> with a REVISION file holding the sha, npm ci --omit=dev, a dump of
# pos_control, the link /srv/pos/current switched in one rename, systemctl restart pos, then
# a wait until /readyz (asked as Host: localhost) reports the new sha. If it never does, the
# previous release is put back. The last 5 releases are kept (the current and previous ones
# always). Releases are root:pos 0750: the app reads its code and cannot change it.
set -Eeuo pipefail
umask 027

POS_ROOT=${POS_ROOT:-/srv/pos}
REPO=$POS_ROOT/repo
RELEASES=$POS_ROOT/releases
CURRENT=$POS_ROOT/current
PREVIOUS_FILE=$POS_ROOT/previous
ENV_FILE=${POS_ENV_FILE:-/etc/pos/pos.env}
DUMP_DIR=${POS_BACKUP_DIR:-/var/backups/pos}/deploy
MONGO_URI=${POS_MONGODB_URI:-mongodb://127.0.0.1:27017}
SERVICE=pos
KEEP=5
KEEP_DUMPS=10
READY_TIMEOUT=90

# To stderr: some functions print their result on stdout
log() { printf '%s pos-deploy: %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() { printf 'pos-deploy: %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '5,8p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

# A value from pos.env (KEY=value lines), or the default
env_value() {
  local key=$1 default=$2 value
  value=$(sed -n "s/^${key}=//p" "$ENV_FILE" 2>/dev/null | tail -n 1 | tr -d '"'"'" || true)
  printf '%s' "${value:-$default}"
}

is_sha() { [[ $1 =~ ^[0-9a-f]{40}$ ]]; }

current_sha() {
  local target
  target=$(readlink "$CURRENT" 2>/dev/null || true)
  target=${target##*/}
  if is_sha "$target"; then printf '%s' "$target"; fi
}

# The commit of a branch name or a (full or short) commit id, after a fetch
resolve_ref() {
  local ref=$1 sha
  [[ $ref =~ ^[A-Za-z0-9._/-]{1,100}$ ]] || die "not a branch or commit: $ref"
  log "fetching from origin"
  git --git-dir="$REPO" fetch --prune --force --quiet origin '+refs/heads/*:refs/remotes/origin/*'
  if sha=$(git --git-dir="$REPO" rev-parse --verify --quiet "refs/remotes/origin/$ref^{commit}"); then
    printf '%s' "$sha"
  elif [[ $ref =~ ^[0-9a-f]{7,40}$ ]] && sha=$(git --git-dir="$REPO" rev-parse --verify --quiet "$ref^{commit}"); then
    printf '%s' "$sha"
  else
    die "no branch or commit $ref in $REPO"
  fi
}

# /srv/pos/releases/<sha>, built in a temporary folder and renamed when complete
build_release() {
  local sha=$1 dir=$RELEASES/$1 tmp
  if [[ -d $dir ]]; then
    log "release ${sha:0:12} already built"
    return
  fi
  tmp=$(mktemp -d "$RELEASES/.build-$sha.XXXXXX")
  trap 'rm -rf "$tmp"' ERR
  log "building ${sha:0:12} in $tmp"
  git --git-dir="$REPO" archive --format=tar "$sha" | tar -x -C "$tmp" --no-same-owner
  printf '%s\n' "$sha" > "$tmp/REVISION"
  [[ -f $tmp/package-lock.json && -f $tmp/server.js ]] || die "$sha has no package-lock.json or server.js"
  (cd "$tmp" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
  (cd "$tmp" && /usr/bin/node --check server.js)
  chown -R root:pos "$tmp"
  chmod -R u=rwX,g=rX,o= "$tmp"
  chmod 0750 "$tmp"
  mv -T "$tmp" "$dir"
  trap - ERR
}

# pos_control as it is before the switch (a new release may change it)
dump_control() {
  local control file
  control=$(env_value CONTROL_DB pos_control)
  [[ $control =~ ^pos_[a-z0-9_]{1,40}$ ]] || die "CONTROL_DB=$control"
  install -d -m 0700 -o root -g root "$DUMP_DIR"
  file=$DUMP_DIR/$control-$(date -u +%Y%m%dT%H%M%SZ).archive.gz
  log "dumping $control to $file"
  (umask 077 && mongodump --quiet --uri="$MONGO_URI" --db="$control" --gzip --archive="$file")
  # Keep the newest ones
  find "$DUMP_DIR" -maxdepth 1 -type f -name "$control-*.archive.gz" -printf '%T@ %p\n' | sort -rn | tail -n +$((KEEP_DUMPS + 1)) | cut -d' ' -f2- | xargs -r rm -f --
}

# current -> releases/<sha>, in one rename (ln -sfn alone removes the old link first)
switch_to() {
  local sha=$1
  ln -sfn "$RELEASES/$sha" "$POS_ROOT/.current.new"
  mv -T "$POS_ROOT/.current.new" "$CURRENT"
  touch -h "$RELEASES/$sha"
  log "current -> ${sha:0:12}"
}

# /readyz answers only for Host localhost; the app reads its sha from the REVISION file
wait_ready() {
  local sha=$1 check_sha=$2 port body got deadline
  port=$(env_value PORT 3401)
  deadline=$((SECONDS + READY_TIMEOUT))
  while ((SECONDS < deadline)); do
    if body=$(curl -fsS --max-time 3 -H 'Host: localhost' "http://127.0.0.1:$port/readyz" 2>/dev/null); then
      if [[ $check_sha == no ]]; then
        log "ready (sha not checked): $body"
        return 0
      fi
      got=$(printf '%s' "$body" | /usr/bin/node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).sha??""))}catch{}})')
      if [[ -n $got && ( $got == "$sha" || ( ${#got} -ge 7 && $sha == "$got"* ) ) ]]; then
        log "ready on ${sha:0:12}"
        return 0
      fi
    fi
    sleep 2
  done
  return 1
}

restart_and_wait() {
  local sha=$1 check_sha=$2
  systemctl restart "$SERVICE"
  wait_ready "$sha" "$check_sha"
}

# Keep the newest $KEEP releases, and always the current and previous ones
prune_releases() {
  local current previous dir name
  current=$(current_sha)
  previous=$(cat "$PREVIOUS_FILE" 2>/dev/null || true)
  find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -name '.build-*' -mmin +60 -exec rm -rf {} +
  while read -r dir; do
    name=${dir##*/}
    is_sha "$name" || continue
    [[ $name == "$current" || $name == "$previous" ]] && continue
    log "removing old release ${name:0:12}"
    rm -rf -- "$dir"
  done < <(find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -regextype posix-extended -regex '.*/[0-9a-f]{40}' -printf '%T@ %p\n' | sort -rn | tail -n +$((KEEP + 1)) | cut -d' ' -f2-)
}

cmd_deploy() {
  local ref=main check_sha=yes sha before
  for arg in "$@"; do
    case $arg in
      --no-sha-check) check_sha=no ;;
      -*) usage ;;
      *) ref=$arg ;;
    esac
  done
  sha=$(resolve_ref "$ref")
  before=$(current_sha)
  if [[ $sha == "$before" ]]; then
    log "${sha:0:12} is already the current release"
  fi
  build_release "$sha"
  dump_control
  switch_to "$sha"
  if [[ -n $before && $before != "$sha" ]]; then printf '%s\n' "$before" > "$PREVIOUS_FILE"; fi
  if restart_and_wait "$sha" "$check_sha"; then
    prune_releases
    log "deployed ${sha:0:12} ($ref)"
    return 0
  fi
  log "the new release did not become ready in ${READY_TIMEOUT}s"
  journalctl -u "$SERVICE" -n 30 --no-pager || true
  if [[ -n $before && $before != "$sha" && -d $RELEASES/$before ]]; then
    log "rolling back to ${before:0:12}"
    switch_to "$before"
    rm -f "$PREVIOUS_FILE"
    restart_and_wait "$before" no || log "the previous release is not ready either: check journalctl -u $SERVICE"
  fi
  die "deploy of ${sha:0:12} failed"
}

cmd_rollback() {
  local target=${1:-} current matches
  current=$(current_sha)
  if [[ -z $target ]]; then
    target=$(cat "$PREVIOUS_FILE" 2>/dev/null || true)
    [[ -n $target ]] || die "no previous release recorded; give a sha (pos-deploy status lists them)"
  else
    [[ $target =~ ^[0-9a-f]{7,40}$ ]] || die "not a commit id: $target"
    mapfile -t matches < <(find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -name "$target*" -printf '%f\n' | grep -E '^[0-9a-f]{40}$' || true)
    ((${#matches[@]} == 1)) || die "$target matches ${#matches[@]} releases"
    target=${matches[0]}
  fi
  is_sha "$target" && [[ -d $RELEASES/$target ]] || die "release $target is not on this server"
  [[ $target != "$current" ]] || die "${target:0:12} is already the current release"
  switch_to "$target"
  if [[ -n $current ]]; then printf '%s\n' "$current" > "$PREVIOUS_FILE"; fi
  restart_and_wait "$target" no || die "rolled back to ${target:0:12}, but /readyz does not answer: journalctl -u $SERVICE"
  log "rolled back to ${target:0:12}"
}

cmd_status() {
  local current port
  current=$(current_sha)
  port=$(env_value PORT 3401)
  echo "current:  ${current:-none}"
  echo "previous: $(cat "$PREVIOUS_FILE" 2>/dev/null || echo none)"
  echo "releases:"
  find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -regextype posix-extended -regex '.*/[0-9a-f]{40}' -printf '  %TY-%Tm-%Td %TH:%TM  %f\n' | sort -r
  echo "service:  $(systemctl is-active "$SERVICE" || true)"
  echo "readyz:   $(curl -sS --max-time 3 -H 'Host: localhost' "http://127.0.0.1:$port/readyz" 2>&1 || true)"
}

main() {
  [[ $(id -u) -eq 0 ]] || die "run as root"
  [[ -d $REPO && -d $RELEASES ]] || die "$REPO or $RELEASES is missing (docs/ops-runbook.md, steps 3 and 4)"
  # One deploy at a time
  exec 9>/run/pos-deploy.lock
  flock -n 9 || die "another pos-deploy is running"
  local cmd=${1:-}
  shift || true
  case $cmd in
    deploy) cmd_deploy "$@" ;;
    rollback) cmd_rollback "$@" ;;
    status) cmd_status ;;
    *) usage ;;
  esac
}

main "$@"
