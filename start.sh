#!/bin/bash
# 一键启动：先清理残留进程，再后台拉起 server.js 与 keepalive.js
# 用法： bash start.sh
pkill -f "node server.js"     2>/dev/null
pkill -f "node keepalive.js"  2>/dev/null
sleep 1

nohup node server.js      > server.log     2>&1 &
nohup node keepalive.js   > keepalive.log  2>&1 &
disown -a 2>/dev/null

echo "OK: 已后台启动 server.js 与 keepalive.js"
echo "查看服务日志: tail -f server.log"
echo "查看心跳日志: tail -f keepalive.log"
