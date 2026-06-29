# 同时装 Python + Node + Claude Code CLI（路 A 需要 claude 无头模式）
FROM python:3.11-slim

# Node 20 + Claude Code CLI
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && npm install -g @anthropic-ai/claude-code \
    && apt-get purge -y curl && apt-get autoremove -y \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

# Claude Code 不允许 root + --dangerously-skip-permissions：改用非 root 用户跑
RUN useradd -m -u 1001 appuser && chown -R appuser:appuser /app
USER appuser
ENV HOME=/home/appuser

CMD ["python", "web/run.py"]
