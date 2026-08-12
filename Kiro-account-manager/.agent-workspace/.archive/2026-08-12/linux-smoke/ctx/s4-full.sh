#!/bin/sh
# 场景 2(0600 拒启/放行) + 4(字节兼容) + 5(真的能服务)
set -u
STEP() { echo ""; echo "########## $* ##########"; }

STEP "0 准备(含探针补丁 · 仅容器内副本)"
cd /work || exit 90
rm -rf /work/node_modules /work/out
cp /ctx/app/package.json /work/package.json
cp /ctx/app/package-lock.wt.json /work/package-lock.json
mkdir -p /work/out
cp -r /ctx/app/out/server /work/out/
cp -r /ctx/app/out/webPanel /work/out/
npm ci --omit=dev --ignore-scripts >/tmp/ci.log 2>&1; echo "CI_EXIT=$?"
rm -rf /work/node_modules/electron
sed -i '6s|.*|const _confNS = require("conf"); const Conf = _confNS.default \|\| _confNS;|' /work/out/server/index.js
sed -n '6p' /work/out/server/index.js
echo "--- out 布局(webPanelAssetRoot 依赖 __dirname/../webPanel) ---"
ls -la /work/out; ls -la /work/out/server | head -4; ls /work/out/webPanel

STEP "4 字节兼容:拷入 Windows 桌面 conf 写的 kiro-accounts.json"
D=/data/migrated; rm -rf $D; mkdir -p $D
cp /ctx/winstore/kiro-accounts.json $D/kiro-accounts.json
echo "sha256(linux side)  = $(sha256sum $D/kiro-accounts.json | cut -d' ' -f1)"
echo "size                = $(stat -c%s $D/kiro-accounts.json)"
ls -l $D

echo "--- 启服务(面板 127.0.0.1:5599) ---"
KIRO_DATA_DIR=$D KIRO_PANEL_HOST=127.0.0.1 KIRO_PANEL_PORT=5599 \
  node out/server/index.js >/tmp/srv.log 2>&1 &
SRV=$!
sleep 7
cat /tmp/srv.log
KEY=$(grep -oE 'adminKey: [A-Za-z0-9_-]+' /tmp/srv.log | head -1 | awk '{print $2}')
echo "PARSED_KEY_LEN=${#KEY}"

STEP "2 场景2:0600 语义在真 POSIX 上"
ls -l $D/adminKey; stat -c '权限=%a 属主=%U:%G' $D/adminKey

STEP "5 场景5:面板真的应答 HTTP + 账号数据真的读出来了"
PANEL_BASE=http://127.0.0.1:5599 PANEL_KEY="$KEY" node /ctx/http-probe.cjs 2>&1

STEP "停机"
kill -TERM $SRV; sleep 4; tail -4 /tmp/srv.log; wait $SRV 2>/dev/null; echo "SRV_EXIT=$?"

STEP "2b 场景2:把密钥文件 chmod 644 后重启 → 期望拒启(POSIX 分支第一次真跑)"
chmod 644 $D/adminKey; stat -c '%a' $D/adminKey
KIRO_DATA_DIR=$D KIRO_PANEL_PORT=5599 node out/server/index.js >/tmp/perm644.log 2>&1
echo "PERM644_EXIT=$?"; tail -8 /tmp/perm644.log

STEP "2c 场景2:chmod 400(比 0600 更严)→ 期望放行,不拒启"
chmod 400 $D/adminKey; stat -c '%a' $D/adminKey
KIRO_DATA_DIR=$D KIRO_PANEL_HOST=127.0.0.1 KIRO_PANEL_PORT=5601 timeout 8 node out/server/index.js >/tmp/perm400.log 2>&1
echo "PERM400_TIMEOUT_EXIT=$? (124=超时=起住了=放行)"
grep -E '就绪|启动失败|权限' /tmp/perm400.log | head -6

STEP "2d 场景2:env 预置密钥 KIRO_ADMIN_KEY 与文件不一致 → 期望 exit 78"
chmod 600 $D/adminKey
KIRO_DATA_DIR=$D KIRO_ADMIN_KEY=SOME-OTHER-KEY-123 node out/server/index.js >/tmp/conflict.log 2>&1
echo "CONFLICT_EXIT=$?"; tail -6 /tmp/conflict.log

STEP "2e 场景2:env 预置为空 → 期望拒启"
KIRO_DATA_DIR=$D KIRO_ADMIN_KEY="   " node out/server/index.js >/tmp/emptyenv.log 2>&1
echo "EMPTYENV_EXIT=$?"; tail -5 /tmp/emptyenv.log

STEP "2f 场景2:非 root 用户 + 目录 700 完整跑一遍(真实 systemd 服务用户形态)"
D2=/data/asuser; rm -rf $D2; mkdir -p $D2
cp /ctx/winstore/kiro-accounts.json $D2/kiro-accounts.json
chown -R 1000:1000 $D2; chmod 700 $D2
su node -s /bin/sh -c "cd /work && KIRO_DATA_DIR=$D2 KIRO_PANEL_HOST=127.0.0.1 KIRO_PANEL_PORT=5602 timeout 8 node out/server/index.js" >/tmp/asuser.log 2>&1
echo "ASUSER_TIMEOUT_EXIT=$? (124=起住了)"
grep -E '就绪|adminKey:|启动失败' /tmp/asuser.log | head -5
ls -l $D2; stat -c '%a %U:%G' $D2/adminKey
