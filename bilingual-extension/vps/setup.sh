#!/usr/bin/env bash
# KOL 双语沟通助手 —— 腾讯云轻量 / 任意 Ubuntu VPS 一键部署脚本
# 用法：把本目录（含 server.js 和 data/）上传到 VPS 后，在本目录运行：bash setup.sh
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

if [ ! -f "$DIR/server.js" ]; then
  echo "❌ 没找到 server.js。请在包含 server.js 和 data/ 的目录里运行本脚本。"
  exit 1
fi

echo "== 1/4 检查 Node.js =="
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt 18 ]; then
  echo "正在安装 Node.js 20（需要几分钟）..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "Node 版本：$(node -v)"

echo "== 2/4 填写配置 =="
read -rp "请粘贴阿里云百炼 API Key（sk- 开头）: " DASH_KEY
read -rp "请设置一个团队口令（同事插件里要填一模一样的，建议 16 位以上随机字符）: " TOKEN
PORT="${KOL_ASSISTANT_PORT:-3210}"

if [ -z "$DASH_KEY" ] || [ -z "$TOKEN" ]; then
  echo "❌ API Key 和团队口令都不能为空。"
  exit 1
fi

echo "== 3/4 写入开机自启服务 =="
SERVICE=/etc/systemd/system/kol-assistant.service
sudo tee "$SERVICE" >/dev/null <<EOF
[Unit]
Description=KOL Bilingual Assistant
After=network.target

[Service]
Type=simple
WorkingDirectory=$DIR
Environment=KOL_ASSISTANT_HOST=0.0.0.0
Environment=KOL_ASSISTANT_PORT=$PORT
Environment=DASHSCOPE_API_KEY=$DASH_KEY
Environment=KOL_ASSISTANT_TOKEN=$TOKEN
ExecStart=$(command -v node) $DIR/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
sudo chmod 600 "$SERVICE"
sudo systemctl daemon-reload
sudo systemctl enable kol-assistant >/dev/null 2>&1 || true
sudo systemctl restart kol-assistant

# 顺手放行系统自带防火墙（如果开着）。注意：腾讯云控制台的「防火墙」要单独开！
sudo ufw allow "$PORT"/tcp >/dev/null 2>&1 || true

echo "== 4/4 自检 =="
sleep 2
if curl -s "http://127.0.0.1:$PORT/health" | grep -q '"ok":true'; then
  echo "✅ 服务已在本机启动并设为开机自启。"
else
  echo "⚠️ 暂时没自检成功，过几秒后可运行：curl http://127.0.0.1:$PORT/health"
  echo "   查看日志：sudo journalctl -u kol-assistant -n 50 --no-pager"
fi

IP="$(curl -s https://api.ipify.org || echo 你的公网IP)"
echo ""
echo "下一步："
echo "1) 去腾讯云控制台 → 轻量应用服务器 → 防火墙，放行 TCP $PORT 端口。"
echo "2) 浏览器打开 http://$IP:$PORT/health 能看到 JSON 就说明外网通了。"
echo "3) 同事在插件「⚙️ 服务器设置」里填：地址 http://$IP:$PORT ，口令 = 你刚设置的团队口令。"
echo ""
echo "常用命令："
echo "  重启服务： sudo systemctl restart kol-assistant"
echo "  看日志：   sudo journalctl -u kol-assistant -f"
echo "  改 Key/口令后重新部署： 重新 bash setup.sh"
