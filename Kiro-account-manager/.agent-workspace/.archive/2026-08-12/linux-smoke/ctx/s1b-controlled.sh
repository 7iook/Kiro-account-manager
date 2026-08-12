#!/bin/sh
# 场景1b:受控对照 —— 只改一个变量,看结论是否翻转
set -u
LOCK="$1"
cd /work || exit 90
rm -rf /work/node_modules /work/package.json /work/package-lock.json
cp "/ctx/app/package.json" /work/package.json || exit 91
cp "/ctx/app/package-lock.${LOCK}.json" /work/package-lock.json || exit 92
mkdir -p /work/out
cp -r /ctx/app/out/server /work/out/ 2>/dev/null
cp -r /ctx/app/out/webPanel /work/out/ 2>/dev/null

echo "### A) npm ci --omit=dev --ignore-scripts (排除 postinstall 这一个变量) ###"
npm ci --omit=dev --ignore-scripts 2>&1 | tail -5
echo "A_EXIT=$?"
[ -d /work/node_modules/conf ] && echo "A_conf=PRESENT" || echo "A_conf=ABSENT"
[ -d /work/node_modules/electron ] && echo "A_electron=PRESENT" || echo "A_electron=ABSENT"
node -e "require('/work/out/server/index.js');console.log('A_BUNDLE=LOADED_OK')" 2>&1 | tail -3

echo ""
echo "### B) 把 electron 整个删掉,再 require 产物(这才是 K-1~K-3 的真判据) ###"
rm -rf /work/node_modules/electron
[ -d /work/node_modules/electron ] && echo "B_electron=STILL_PRESENT" || echo "B_electron=REMOVED"
node -e "try{require('electron');console.log('B_require_electron=OK(!!)')}catch(e){console.log('B_require_electron=THROWS '+e.code)}" 2>&1
node -e "require('/work/out/server/index.js');console.log('B_BUNDLE=LOADED_OK')" 2>&1 | tail -5
echo "B_BUNDLE_EXIT=$?"

echo ""
echo "### C) 谁把 electron 拉进 prod 树(npm 自己怎么说) ###"
npm ls electron --omit=dev 2>&1 | head -20
echo ""
npm explain electron 2>&1 | head -30
