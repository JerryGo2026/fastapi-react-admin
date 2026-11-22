#!/usr/bin/env bash
# 往模拟器的相册里放一张图（#381）：「换头像」那条流程要从系统照片选择器里选，而模拟器的相册是空的。
#
#     bash apps/mobile/e2e/seed-gallery.sh      # 设备已连上（adb devices 看得到）
#
# 推进去 → 触发媒体扫描 → 回查 MediaStore 确认真的进了索引。不回查的话扫描没生效时
# 照片选择器是空的，流程会在系统界面上干等到超时，报的是「icon_thumbnail 不可见」。
#
# 🔴 单独成一个文件，不写进 workflow 的 `script:`：按 android-emulator-runner 的文档，它把 `script` **逐行**
# 交给 shell 执行，多行的 for 循环会被拆散（没在 CI 上故意写坏验过）。
set -euo pipefail

SRC="$(dirname "$0")/fixtures/e2e-avatar.png"
DST=/sdcard/Pictures/e2e-avatar.png

adb push "$SRC" "$DST"
adb shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d "file://$DST"

for i in $(seq 1 15); do
  # 先收进变量再 grep：管道里的 `grep -q` 一命中就退出，adb 还在写的话吃 SIGPIPE（141），
  # `pipefail` 会把整条判成假 —— 图明明在索引里，却在相册有别的图时报「查不到」
  out=$(adb shell content query --uri content://media/external/images/media --projection _display_name || true)
  if grep -q e2e-avatar.png <<<"$out"; then
    echo "相册里有测试图了（第 $i 次查询）"
    exit 0
  fi
  sleep 2
done
echo "30 秒内 MediaStore 里查不到 e2e-avatar.png：" >&2
adb shell content query --uri content://media/external/images/media --projection _display_name >&2 || true
exit 1
