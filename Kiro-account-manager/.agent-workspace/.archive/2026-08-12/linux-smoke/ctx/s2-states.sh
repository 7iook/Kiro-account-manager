#!/bin/sh
# 场景 2/3/4/5:0600 语义 · 四态退出码 · 字节兼容 · 真的能服务
# 前置:/work 已由 s1b 之外独立装好(本脚本自己装,--ignore-scripts 绕开 electron-builder)
set -u

STEP() { echo ""; echo "########## $* ##########"; }

STEP "0 准备:npm ci --omit=dev --ignore-scripts + 删掉 electron"
cd /work || exit 90
rm -rf /work/node_modules
cp /ctx/app/package.json /work/package.json
cp /ctx/app/package-lock.wt.json /work/package-lock.json
mkdir -p /work/out
cp -r /ctx/app/out/server /work/out/
cp -r /ctx/app/out/webPanel /work/out/
npm ci --omit=dev --ignore-scripts >/tmp/ci.log 2>&1
echo "CI_EXIT=$?"
rm -rf /work/node_modules/electron
node -e "try{require('electron')}catch(e){console.log('electron_unreachable='+e.code)}"
echo "umask=$(umask)"
echo "id=$(id)"

run_server() {
  # $1=label  $2=datadir  其余环境变量由调用方 export
  echo "--- [$1] node out/server/index.js ---"
  timeout 20 node out/server/index.js 2>&1
  echo "[$1] EXIT=$?"
}

STEP "3a 四态 · absent(数据文件不存在)→ 应以空库启动(不是拒启)"
D=/data/absent; rm -rf $D; mkdir -p $D
KIRO_DATA_DIR=$D KIRO_PANEL_PORT=0 timeout 8 node out/server/index.js 2>&1 | head -40
echo "3a_PIPE_DONE"

STEP "3b 四态 · KIRO_DATA_DIR 未设置 → 期望 exit 64"
( unset KIRO_DATA_DIR; node out/server/index.js >/tmp/3b.log 2>&1; echo "3b_EXIT=$?" )
tail -6 /tmp/3b.log

STEP "3c 非法端口 → 期望 exit 64"
KIRO_DATA_DIR=/data/absent KIRO_PANEL_PORT=808o node out/server/index.js >/tmp/3c.log 2>&1
echo "3c_EXIT=$?"
tail -4 /tmp/3c.log

STEP "3d 四态 · undecryptable(垃圾字节)→ 期望 exit 65"
D=/data/bad; rm -rf $D; mkdir -p $D
printf 'this-is-not-a-conf-file-at-all' > $D/kiro-accounts.json
KIRO_DATA_DIR=$D node out/server/index.js >/tmp/3d.log 2>&1
echo "3d_EXIT=$?"
tail -6 /tmp/3d.log

STEP "3e 四态 · 零字节文件 → 期望 exit 65"
D=/data/zero; rm -rf $D; mkdir -p $D; : > $D/kiro-accounts.json
KIRO_DATA_DIR=$D node out/server/index.js >/tmp/3e.log 2>&1
echo "3e_EXIT=$?"
tail -5 /tmp/3e.log

STEP "3f 四态 · version-too-new(schemaVersion=999,明文 JSON)→ 期望 exit 65"
D=/data/newver; rm -rf $D; mkdir -p $D
printf '{"schemaVersion":999,"accountData":{"accounts":[]}}' > $D/kiro-accounts.json
KIRO_DATA_DIR=$D node out/server/index.js >/tmp/3f.log 2>&1
echo "3f_EXIT=$?"
tail -5 /tmp/3f.log

STEP "3g 四态 · not-writable · 文件 0444(目录可写)→ 期望 exit 73"
D=/data/rofile; rm -rf $D; mkdir -p $D
cp /ctx/winstore/kiro-accounts.json $D/kiro-accounts.json
chmod 444 $D/kiro-accounts.json
ls -l $D
# root 会绕过 access(W_OK)?先以 root 试,再以非 root 试
KIRO_DATA_DIR=$D node out/server/index.js >/tmp/3g-root.log 2>&1
echo "3g_ROOT_EXIT=$?"; tail -4 /tmp/3g-root.log
chown -R 1000:1000 $D 2>/dev/null; chmod 444 $D/kiro-accounts.json; chmod 755 $D
su node -s /bin/sh -c "cd /work && KIRO_DATA_DIR=$D node out/server/index.js" >/tmp/3g-user.log 2>&1
echo "3g_USER_EXIT=$?"; tail -6 /tmp/3g-user.log

STEP "3h 四态 · not-writable · 目录只读 0555 → 期望 exit 73"
D=/data/rodir; rm -rf $D; mkdir -p $D
cp /ctx/winstore/kiro-accounts.json $D/kiro-accounts.json
chown -R 1000:1000 $D; chmod 555 $D
su node -s /bin/sh -c "cd /work && KIRO_DATA_DIR=$D node out/server/index.js" >/tmp/3h.log 2>&1
echo "3h_EXIT=$?"; tail -5 /tmp/3h.log
