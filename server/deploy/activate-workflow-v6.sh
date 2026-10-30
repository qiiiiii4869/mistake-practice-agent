#!/bin/bash
# Run as the existing server administrator after release tests pass.
set -Eeuo pipefail
task_release=${1:?release_path_required}
[[ "$task_release" =~ ^/opt/mistake-agent/releases/20261028-workflow-v6-[0-9]+$ ]] || exit 2
task_node=/opt/mistake-agent/runtime/node-v24.16.0-linux-x64/bin/node
task_database=/var/lib/user-store/users.sqlite3
task_previous=$(readlink -f /opt/mistake-agent/current)
task_backup=/var/lib/user-store/workflow-deploy-backups/$(basename "$task_release")
task_dropin=/etc/systemd/system/mistake-agent-accounts.service.d/workflow-v6.conf
test -f "$task_release/src/report-runs.mjs"
test -f "$task_database"
test -L /opt/mistake-agent/current
test ! -e /opt/mistake-agent/current.next
test ! -e "$task_dropin"
test ! -e "$task_backup"
install -d -m 700 -o mistake-agent -g mistake-agent /var/lib/user-store/workflow-deploy-backups
install -d -m 700 -o mistake-agent -g mistake-agent "$task_backup"
runuser -u mistake-agent -- test -w "$task_backup"
install -m 600 /etc/systemd/system/mistake-agent-accounts.service "$task_backup/previous.service"
printf '%s\n' "$task_previous" > "$task_backup/previous-release.txt"
chmod 600 "$task_backup/previous-release.txt"
task_snapshot_ready=0
task_switched=0
rollback(){
  trap - ERR
  set +e
  systemctl stop mistake-agent-accounts.service
  if [[ "$task_snapshot_ready" == 1 ]]; then
    runuser -u mistake-agent -- env DATABASE_PATH="$task_database" "$task_node" "$task_release/src/backup.mjs" "$task_backup/failed-state.sqlite3"
    cp -p "$task_backup/accounts-before.sqlite3" "$task_database"
    rm -f /var/lib/user-store/users.sqlite3-wal /var/lib/user-store/users.sqlite3-shm
    chown mistake-agent:mistake-agent "$task_database"
    chmod 600 "$task_database"
  fi
  if [[ "$task_switched" == 1 ]]; then
    ln -s "$task_previous" /opt/mistake-agent/current.rollback
    mv -Tf /opt/mistake-agent/current.rollback /opt/mistake-agent/current
  fi
  rm -f "$task_dropin"
  systemctl daemon-reload
  systemctl start mistake-agent-accounts.service
  echo 'Deployment rolled back; private before/failed snapshots retained.' >&2
  exit 1
}
trap rollback ERR
systemctl stop mistake-agent-accounts.service
runuser -u mistake-agent -- env DATABASE_PATH="$task_database" "$task_node" "$task_release/src/backup.mjs" "$task_backup/accounts-before.sqlite3"
chmod 600 "$task_backup/accounts-before.sqlite3"
task_snapshot_ready=1
runuser -u mistake-agent -- "$task_node" "$task_release/deploy/verify-upgrade.mjs" "$task_database" "$task_backup/accounts-before.sqlite3" migrate
install -d -m 755 /etc/systemd/system/mistake-agent-accounts.service.d
printf '%s\n' '[Service]' 'Environment=MODEL_KEY_FILE=/var/lib/user-store/shared-model-key' 'Environment=ALLOW_LOCAL_CREDENTIALS=false' 'Environment=WORKFLOW_DELIVERY_ENABLED=false' > "$task_dropin"
chmod 644 "$task_dropin"
ln -s "$task_release" /opt/mistake-agent/current.next
mv -Tf /opt/mistake-agent/current.next /opt/mistake-agent/current
task_switched=1
systemctl daemon-reload
systemctl start mistake-agent-accounts.service
task_healthy=0
for task_attempt in $(seq 1 15); do
  if curl -fsS http://127.0.0.1:8787/health > /dev/null; then task_healthy=1; break; fi
  sleep 1
done
test "$task_healthy" = 1
test "$(curl -s -o /dev/null -w '%{http_code}' https://codeqiqi.com/mistake-agent/health)" = 200
test "$(curl -s -o /dev/null -w '%{http_code}' https://codeqiqi.com/mistake-agent/v2/model-status)" = 401
test "$(curl -s -o /dev/null -w '%{http_code}' https://codeqiqi.com/)" = 200
trap - ERR
printf 'Activated %s\nBackup retained at %s\n' "$task_release" "$task_backup"
