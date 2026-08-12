#!/bin/sh
# 场景1:真实 --omit=dev 安装 + conf 解析验证
# 参数 $1 = 用哪个 lockfile(head / wt)
set -u
LOCK="$1"
cd /work || exit 90
rm -rf /work/node_modules
cp "/ctx/app/package.json" /work/package.json || exit 91
cp "/ctx/app/package-lock.${LOCK}.json" /work/package-lock.json || exit 92
mkdir -p /work/out
cp -r /ctx/app/out/server /work/out/ || exit 93
cp -r /ctx/app/out/webPanel /work/out/ || exit 94

echo "=== node/npm 版本 ==="
node -v; npm -v
echo "=== lockfile: ${LOCK} ==="

echo "=== npm ci --omit=dev ==="
npm ci --omit=dev 2>&1
CI_EXIT=$?
echo "NPM_CI_EXIT=${CI_EXIT}"

echo "=== node_modules 里是否有 conf / electron ==="
[ -d /work/node_modules/conf ] && echo "conf: PRESENT ($(node -e "console.log(require('/work/node_modules/conf/package.json').version)" 2>/dev/null))" || echo "conf: ABSENT"
[ -d /work/node_modules/electron ] && echo "electron: PRESENT" || echo "electron: ABSENT"
[ -d /work/node_modules/electron-store ] && echo "electron-store: PRESENT" || echo "electron-store: ABSENT"

echo "=== require('electron') 在这个环境里到底是什么 ==="
node -e "try{const e=require('electron');console.log('REQUIRE_ELECTRON_OK type='+typeof e)}catch(e){console.log('REQUIRE_ELECTRON_THROWS code='+e.code)}" 2>&1

echo "=== require(out/server/index.js) ==="
node -e "require('/work/out/server/index.js'); console.log('LOADED_OK')" 2>&1
echo "REQUIRE_BUNDLE_EXIT=$?"
