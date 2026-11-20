#!/usr/bin/env bash
# 加密备份报价站点。默认每天由 quote-backup.timer 调用。
#
# 密钥默认在 /root/.quote-backup.key，绝不能和备份放在同一台机器，
# 请把密钥副本保存到密码管理器或另一台受控设备。
set -euo pipefail
umask 077

if [ -f /etc/quote-backup.env ]; then
  # shellcheck disable=SC1091
  . /etc/quote-backup.env
fi

SITE="${SITE:-/var/www/quote.byberg.store}"
DEST="${DEST:-/root/backups}"
KEEP="${KEEP:-14}"
KEY_FILE="${KEY_FILE:-/root/.quote-backup.key}"
OFFSITE_GIT_DIR="${OFFSITE_GIT_DIR:-}"
OFFSITE_KEEP="${OFFSITE_KEEP:-30}"
GIT_SSH_KEY="${GIT_SSH_KEY:-/root/.ssh/quote-backup-deploy}"
STAMP="$(date +%Y%m%d-%H%M%S)"
NAME="quote-$STAMP.tar.gz.enc"

if [ ! -d "$SITE/data" ]; then
  echo "!! 站点数据目录不存在: $SITE/data" >&2
  exit 1
fi
command -v openssl >/dev/null 2>&1 || { echo "!! 缺少 openssl" >&2; exit 1; }
command -v flock >/dev/null 2>&1 || { echo "!! 缺少 flock" >&2; exit 1; }

exec 9>/run/lock/quote-backup.lock
if ! flock -n 9; then
  echo "已有备份任务在运行，本次跳过"
  exit 0
fi

mkdir -p "$DEST"
chmod 700 "$DEST"
if [ ! -s "$KEY_FILE" ]; then
  mkdir -p "$(dirname "$KEY_FILE")"
  openssl rand -base64 48 > "$KEY_FILE"
  chmod 600 "$KEY_FILE"
  echo "已生成备份密钥: $KEY_FILE（请立即另存到站外）"
fi
chmod 600 "$KEY_FILE"

TMP_PLAIN="$(mktemp "$DEST/.quote-backup-plain.XXXXXX")"
TMP_ENC="$(mktemp "$DEST/.quote-backup-encrypted.XXXXXX")"
cleanup() { rm -f -- "$TMP_PLAIN" "$TMP_ENC"; }
trap cleanup EXIT

BACKUP_DIRS=(server public data)
[ -d "$SITE/scripts" ] && BACKUP_DIRS+=(scripts)
[ -d "$SITE/脚本" ] && BACKUP_DIRS+=("脚本")

tar czf "$TMP_PLAIN" \
  --exclude='*.xlsx' \
  --exclude='scripts/data.json' \
  --exclude='scripts/rates_raw.json' \
  --exclude='scripts/divider_rates.json' \
  --exclude='scripts/surcharges.json' \
  --exclude='scripts/data_v2.js' \
  --exclude='scripts/data_v2.json' \
  --exclude='__pycache__' \
  --exclude='*.pyc' \
  -C "$SITE" "${BACKUP_DIRS[@]}"

# 加密前后都验证归档可读，避免把损坏备份当成可恢复备份。
tar -tzf "$TMP_PLAIN" >/dev/null
openssl enc -aes-256-cbc -salt -pbkdf2 -iter 250000 \
  -in "$TMP_PLAIN" -out "$TMP_ENC" -pass "file:$KEY_FILE"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 250000 \
  -in "$TMP_ENC" -pass "file:$KEY_FILE" | tar -tzf - >/dev/null

mv -- "$TMP_ENC" "$DEST/$NAME"
chmod 600 "$DEST/$NAME"
sha256sum "$DEST/$NAME" > "$DEST/$NAME.sha256"
chmod 600 "$DEST/$NAME.sha256"
SIZE="$(du -h "$DEST/$NAME" | cut -f1)"
echo "加密备份完成: $DEST/$NAME ($SIZE)"

# 本地只保留最近 KEEP 份。
find "$DEST" -maxdepth 1 -type f -name 'quote-*.tar.gz.enc' -printf '%T@ %p\n' \
  | sort -rn | tail -n +$((KEEP + 1)) | cut -d' ' -f2- | while IFS= read -r old; do
      [ -n "$old" ] || continue
      rm -f -- "$old" "$old.sha256"
      echo "  删除旧备份: $(basename "$old")"
    done

# 可选异地：一个私有 Git 仓库，里面只放加密文件。
if [ -n "$OFFSITE_GIT_DIR" ]; then
  if [ ! -d "$OFFSITE_GIT_DIR/.git" ]; then
    echo "!! 异地备份目录不是 Git 仓库: $OFFSITE_GIT_DIR" >&2
    exit 1
  fi
  mkdir -p "$OFFSITE_GIT_DIR/backups"
  cp -f -- "$DEST/$NAME" "$OFFSITE_GIT_DIR/backups/$NAME"
  chmod 600 "$OFFSITE_GIT_DIR/backups/$NAME"
  find "$OFFSITE_GIT_DIR/backups" -maxdepth 1 -type f -name 'quote-*.tar.gz.enc' \
    -printf '%T@ %p\n' | sort -rn | tail -n +$((OFFSITE_KEEP + 1)) \
    | cut -d' ' -f2- | while IFS= read -r old; do
        [ -n "$old" ] || continue
        rm -f -- "$old"
      done
  (
    cd "$OFFSITE_GIT_DIR/backups"
    sha256sum quote-*.tar.gz.enc > SHA256SUMS
    chmod 600 SHA256SUMS
  )
  git -C "$OFFSITE_GIT_DIR" config user.name "Logistics Quote Backup"
  git -C "$OFFSITE_GIT_DIR" config user.email "quote-backup@localhost"
  git -C "$OFFSITE_GIT_DIR" add backups
  if ! git -C "$OFFSITE_GIT_DIR" diff --cached --quiet; then
    git -C "$OFFSITE_GIT_DIR" commit -m "backup $STAMP"
    GIT_SSH_COMMAND="ssh -i $GIT_SSH_KEY -o BatchMode=yes -o StrictHostKeyChecking=accept-new" \
      git -C "$OFFSITE_GIT_DIR" push origin HEAD:main
  fi
  echo "异地加密备份已推送: $OFFSITE_GIT_DIR"
fi
