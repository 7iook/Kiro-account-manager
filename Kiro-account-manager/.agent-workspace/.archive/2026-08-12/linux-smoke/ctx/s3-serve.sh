#!/bin/sh
# 场景 2(0600 语义) + 4(字节兼容) + 5(真的能服务)
# 为绕开「Conf is not a constructor」这个平台无关缺陷,对**容器内的产物副本**打探针补丁
# (仓库文件零改动)。所有结论因此标 verified-with-caveat。
set -u
STEP() { echo ""; echo "########## $* ##########"; }

STEP "0 准备"
cd /work || exit 90
rm -rf /work/node_modules /work/out
cp /ctx/app/package.json /work/package.json
cp /ctx/app/package-lock.wt.json /work/package-lock.json
mkdir -p /work/out
cp -r /ctx/app/out/server /work/out/
cp -r /ctx/app/out/webPanel /work/out/
npm ci --omit=dev --ignore-scripts >/tmp/ci.log 2>&1; echo "CI_EXIT=$?"
rm -rf /work/node_modules/electron
node -e "try{require('electron')}catch(e){console.log('electron_unreachable='+e.code)}"

echo "--- 打探针补丁前后对照(只改产物第 6 行) ---"
sed -n '6p' /work/out/server/index.js
cp /work/out/server/index.js /work/out/server/index.orig.js
sed -i '6s|.*|const _confNS = require("conf"); const Conf = _confNS.default \|\| _confNS;|' /work/out/server/index.js
sed -n '6p' /work/out/server/index.js
echo "DIFF_LINES=$(diff /work/out/server/index.orig.js /work/out/server/index.js | grep -c '^[<>]')"

STEP "5a 空库 + 面板真的能服务(root · 127.0.0.1:5599)"
D=/data/serve; rm -rf $D; mkdir -p $D
KIRO_DATA_DIR=$D KIRO_PANEL_HOST=127.0.0.1 KIRO_PANEL_PORT=5599 \
  node out/server/index.js >/tmp/5a.log 2>&1 &
SRV=$!
sleep 6
echo "--- 启动日志 ---"; cat /tmp/5a.log
KEY=$(grep -oE 'adminKey: [A-Za-z0-9_-]+' /tmp/5a.log | head -1 | awk '{print $2}')
echo "PARSED_KEY_LEN=${#KEY}"
echo "--- 密钥文件权限(场景2 · 0600 在真 POSIX 上) ---"
ls -l $D/adminKey; stat -c '%a %U:%G %n' $D/adminKey

echo "--- HTTP:面板 shell ---"
curl -s -o /tmp/panel.html -w 'GET /panel/ HTTP=%{http_code} bytes=%{size_download}\n' http://127.0.0.1:5599/panel/
head -c 200 /tmp/panel.html; echo ""
echo "--- HTTP:静态资源(webPanelAssetRoot 的 __dirname/../webPanel 是否解析对) ---"
ASSET=$(grep -oE '/panel/assets/[A-Za-z0-9._-]+\.js' /tmp/panel.html | head -1)
echo "ASSET=$ASSET"
curl -s -o /dev/null -w "GET $ASSET HTTP=%{http_code} bytes=%{size_download}\n" "http://127.0.0.1:5599$ASSET"
echo "--- HTTP:错误密钥登录(应 401/403) ---"
curl -s -X POST -H 'Content-Type: application/json' -d '{"adminKey":"WRONG-KEY-xxxx"}' \
  -o /tmp/badlogin.json -w 'POST login(wrong) HTTP=%{http_code}\n' http://127.0.0.1:5599/panel/api/login
cat /tmp/badlogin.json; echo ""
echo "--- HTTP:正确密钥登录(应 200 + Set-Cookie) ---"
curl -s -i -X POST -H 'Content-Type: application/json' -d "{\"adminKey\":\"$KEY\"}" \
  http://127.0.0.1:5599/panel/api/login > /tmp/goodlogin.txt
head -12 /tmp/goodlogin.txt
SID=$(grep -oiE 'set-cookie: [^;]+' /tmp/goodlogin.txt | head -1 | cut -d' ' -f2)
echo "SID=$SID"
echo "--- HTTP:带 cookie 拉账号列表 ---"
curl -s -H "Cookie: $SID" -o /tmp/accounts.json -w 'GET accounts HTTP=%{http_code} bytes=%{size_download}\n' http://127.0.0.1:5599/panel/api/accounts
head -c 400 /tmp/accounts.json; echo ""
echo "--- 停机(SIGTERM) ---"
kill -TERM $SRV; sleep 4
tail -6 /tmp/5a.log
wait $SRV 2>/dev/null; echo "5a_SERVER_EXIT=$?"
