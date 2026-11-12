#!/usr/bin/env bash
# agent-harness 一键环境脚本：Ubuntu 24.04 / Debian 系
# 作用：准备 Node.js 22 → 安装依赖 → 类型检查 + 测试 → 跑一遍离线闭环
# Windows / macOS 无需此脚本，直接在项目根目录执行 npm install && npm test && npm run demo
set -e

cd "$(dirname "$0")/.."

echo "==== 1/4 检查系统 ===="
. /etc/os-release
echo "系统：$PRETTY_NAME  内核：$(uname -r)  CPU：$(nproc) 核"

echo "==== 2/4 准备 Node.js 与 npm ===="
if command -v node >/dev/null 2>&1; then
  echo "已存在 Node：$(node -v)，跳过安装"
else
  # 发行版自带的 nodejs 版本偏旧，改用 NodeSource 官方源装 22.x
  sudo apt-get update -y
  sudo apt-get install -y curl ca-certificates
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "Node $(node -v) / npm $(npm -v)"

echo "==== 3/4 按锁文件安装依赖并自检 ===="
npm ci
npm run typecheck
npm test

echo "==== 4/4 跑一遍离线闭环 ===="
npm run demo

echo "==== 完成 ===="
echo "接真实模型：DEEPSEEK_API_KEY=sk-xxx npm run demo:live"
echo "底层抓取自检：npm run demo:fetch"
