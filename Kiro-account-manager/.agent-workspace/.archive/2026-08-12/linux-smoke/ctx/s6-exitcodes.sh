#!/bin/sh
# 验证退出码修法在真 Linux 上生效(用重建后的产物 + 探针补丁绕开 §2 那个独立缺陷)
set -u
STEP() { echo ""; echo "########## $* ##########"; }

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

D=/data/exitcodes; rm -rf $D; mkdir -p $D
cp /ctx/winstore/kiro-accounts.json $D/kiro-accounts.json

STEP "先正常起一次生成密钥(取得一把真钥匙)"
KIRO_DATA_DIR=$D KIRO_PANEL_HOST=127.0.0.1 KIRO_PANEL_PORT=5610 timeout 6 node out/server/index.js >/tmp/gen.log 2>&1
echo "GEN_TIMEOUT_EXIT=$? (124=起住了)"
stat -c '%a' $D/adminKey

STEP "A 权限过宽(chmod 644) → 期望 73(原为 69)"
chmod 644 $D/adminKey
KIRO_DATA_DIR=$D node out/server/index.js >/tmp/a.log 2>&1; echo "A_EXIT=$?"
grep -E '启动失败' /tmp/a.log

STEP "B env 与文件冲突 → 期望 78(原为 69 · 且 78 此前零生产用点)"
chmod 600 $D/adminKey
KIRO_DATA_DIR=$D KIRO_ADMIN_KEY=SOME-OTHER-KEY-123456 node out/server/index.js >/tmp/b.log 2>&1; echo "B_EXIT=$?"
grep -E '启动失败' /tmp/b.log

STEP "C env 设了但为空 → 期望 64(原为 69)"
KIRO_DATA_DIR=$D KIRO_ADMIN_KEY="   " node out/server/index.js >/tmp/c.log 2>&1; echo "C_EXIT=$?"
grep -E '启动失败' /tmp/c.log

STEP "D 密钥文件零字节 → 期望 65(原为 69)"
: > $D/adminKey; chmod 600 $D/adminKey
KIRO_DATA_DIR=$D node out/server/index.js >/tmp/d.log 2>&1; echo "D_EXIT=$?"
grep -E '启动失败' /tmp/d.log

STEP "E 密钥文件不可读(EACCES · 非 root) → 期望 73"
rm -f $D/adminKey
D2=/data/exitcodes2; rm -rf $D2; mkdir -p $D2
cp /ctx/winstore/kiro-accounts.json $D2/kiro-accounts.json
printf 'a-valid-looking-key-aaaaaaaaaaaaaaaaaaaa\n' > $D2/adminKey
chmod 600 $D2/adminKey; chown root:root $D2/adminKey
chown 1000:1000 $D2 $D2/kiro-accounts.json; chmod 755 $D2
su node -s /bin/sh -c "cd /work && KIRO_DATA_DIR=$D2 node out/server/index.js" >/tmp/e.log 2>&1; echo "E_EXIT=$?"
grep -E '启动失败' /tmp/e.log

STEP "F 回归:正常密钥仍能起住(修法没把好路堵死)"
D3=/data/exitcodes3; rm -rf $D3; mkdir -p $D3
cp /ctx/winstore/kiro-accounts.json $D3/kiro-accounts.json
KIRO_DATA_DIR=$D3 KIRO_PANEL_HOST=127.0.0.1 KIRO_PANEL_PORT=5611 timeout 6 node out/server/index.js >/tmp/f.log 2>&1
echo "F_TIMEOUT_EXIT=$? (124=起住了=好路没堵)"
grep -E '就绪' /tmp/f.log
