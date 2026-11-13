#!/bin/sh
# 每日快照备份：rsync --link-dest 增量快照，保留最近 N 份（默认 14）
# 用法：backup.sh [源目录] [备份根目录]
# 默认值只做占位，部署时用环境变量或参数覆盖：
#   SRC=/path/to/data DEST=/backup/sessionsync KEEP=14 ./backup.sh
set -eu

SRC="${1:-${SRC:-./data}}"
DEST="${2:-${DEST:-/data_s003/backups/sessionsync}}"
KEEP="${KEEP:-14}"
STAMP=$(date +%Y%m%d-%H%M%S)

[ -d "$SRC" ] || { echo "[backup] 源目录不存在: $SRC" >&2; exit 1; }
mkdir -p "$DEST/daily"

# 上一份快照作为硬链接基线（未变化文件不占额外空间）
LATEST=$(ls -1dt "$DEST"/daily/*/ 2>/dev/null | head -1 || true)
LINK_OPT=""
[ -n "$LATEST" ] && LINK_OPT="--link-dest=$LATEST"

# shellcheck disable=SC2086
rsync -a --delete $LINK_OPT "$SRC/" "$DEST/daily/$STAMP/"

# 校验：oplog 行数一致性（若存在）
SRC_LINES=$(wc -l < "$SRC/oplog.jsonl" 2>/dev/null || echo 0)
DST_LINES=$(wc -l < "$DEST/daily/$STAMP/oplog.jsonl" 2>/dev/null || echo 0)
if [ "$SRC_LINES" != "$DST_LINES" ]; then
  echo "[backup] ⚠️ oplog 行数不一致: src=$SRC_LINES dst=$DST_LINES" >&2
fi

# 清理旧快照
COUNT=$(ls -1d "$DEST"/daily/*/ 2>/dev/null | wc -l | tr -d ' ')
if [ "$COUNT" -gt "$KEEP" ]; then
  ls -1dt "$DEST"/daily/*/ | tail -n +$((KEEP + 1)) | while read -r old; do
    rm -rf "$old"
  done
fi

{
  echo "time=$(date '+%F %T')"
  echo "source=$SRC"
  echo "snapshot=$DEST/daily/$STAMP"
  echo "oplog_lines=$DST_LINES"
  echo "snapshots=$(ls -1d "$DEST"/daily/*/ | wc -l | tr -d ' ')"
  echo "size=$(du -sh "$DEST" | cut -f1)"
} > "$DEST/last-backup.txt"

echo "[backup] ✅ $STAMP 完成 · oplog $DST_LINES 行 · 共 $(grep snapshots "$DEST/last-backup.txt" | cut -d= -f2) 份快照 · $(grep size "$DEST/last-backup.txt" | cut -d= -f2)"
