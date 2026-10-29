#!/usr/bin/env bash
# 创建（或打开）今天的工作日志；可选参数会作为一条带时间的记录追加进去。
# 用法: ./scripts/today.sh            # 创建今日日志
#       ./scripts/today.sh "和老王对齐了 Q4 预算"
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
date="$(date +%F)"
file="$root/journal/$date.md"

if [[ ! -f "$file" ]]; then
  sed "s/{{date}}/$date/g" "$root/templates/daily.md" > "$file"
  echo "已创建 $file"
fi

if [[ $# -gt 0 ]]; then
  entry="- $(date +%H:%M) $*"
  # 追加到"工作记录"小节末尾（下一个 ## 标题之前）
  awk -v entry="$entry" '
    /^## 工作记录/ { in_log=1; print; next }
    in_log && /^## / { print entry; print ""; in_log=0; done=1 }
    in_log && /^- HH:MM$/ { next }
    in_log && /^$/ { next }
    { print }
    END { if (in_log && !done) print entry }
  ' "$file" > "$file.tmp" && mv "$file.tmp" "$file"
  echo "已记录：$entry"
fi
