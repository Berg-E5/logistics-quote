#!/usr/bin/env bash
# 备份报价站点, 并只保留最近 N 份。
#
# 用法:
#   ./backup.sh                 # 备份一次
#   KEEP=3 ./backup.sh          # 只留最近 3 份 (默认 5)
#
# 排除掉的大文件 (每次省 ~25MB):
#   scripts/*.xlsx      原始报价表 12.7MB, 重新上传即可
#   scripts/data.json   打包中间产物
#   scripts/rates_raw.json / divider_rates.json / surcharges.json / data_v2.js
#   public/data_v2.js   可从网站根目录再生成
set -u

SITE="${SITE:-/var/www/quote.byberg.store}"
DEST="${DEST:-/root/backups}"
KEEP="${KEEP:-5}"
STAMP="$(date +%Y%m%d-%H%M)"
NAME="quote-$STAMP.tar.gz"

mkdir -p "$DEST"

tar czf "$DEST/$NAME" \
  --exclude='*.xlsx' \
  --exclude='scripts/data.json' \
  --exclude='scripts/rates_raw.json' \
  --exclude='scripts/divider_rates.json' \
  --exclude='scripts/surcharges.json' \
  --exclude='scripts/data_v2.js' \
  --exclude='scripts/data_v2.json' \
  -C "$SITE" server public scripts data 2>/dev/null

SIZE=$(du -h "$DEST/$NAME" | cut -f1)
echo "备份完成: $DEST/$NAME ($SIZE)"

# 只保留最近 KEEP 份 (按时间排序, 删旧的)
ls -1t "$DEST"/quote-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  echo "  删除旧备份: $(basename "$old")"
  rm -f "$old"
done

# 旧的测试页残骸 (每次都带一个, 没用了)
ls -1 "$DEST"/quote-_*.moved-* 2>/dev/null | while read -r f; do
  rm -f "$f"
done

echo "当前保留:"
ls -1t "$DEST"/quote-*.tar.gz 2>/dev/null | head -n "$KEEP" | while read -r f; do
  echo "  $(basename "$f")  $(du -h "$f" | cut -f1)"
done
