#!/bin/sh
set -u
cd /work || exit 90
rm -rf /work/node_modules /work/out
cp /ctx/app/package.json /work/package.json
cp /ctx/app/package-lock.wt.json /work/package-lock.json
mkdir -p /work/out
cp -r /ctx/app/out/server /work/out/
cp -r /ctx/app/out/webPanel /work/out/
cp /work/out/server/index.js /work/out/server/index.orig.js
npm ci --omit=dev --ignore-scripts >/tmp/ci.log 2>&1; echo "CI_EXIT=$?"
rm -rf /work/node_modules/electron
echo "=== external 包的 require(esm) 形状 ==="
cp /ctx/probe-externals.cjs /work/probe-externals.cjs
node /work/probe-externals.cjs 2>&1
