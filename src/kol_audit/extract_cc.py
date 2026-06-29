"""识别后端（路 A）：用 Claude Code 无头模式（CLI）把 PDF 读成字段。

复用你的 Claude Code 订阅 token，**不需要 ANTHROPIC_API_KEY**。
认证：环境变量 CLAUDE_CODE_OAUTH_TOKEN（用 `claude setup-token` 生成）。

原理：把 PDF 路径交给 `claude -p`，让它用 Read 工具读文件、只输出 JSON，
再校验成 Approval / Contract 模型。和 API 版输出同样的结构化字段，核对逻辑零改动。
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path

from .extract import _APPROVAL_PROMPT, _CONTRACT_PROMPT
from .models import Approval, Contract

CLAUDE_BIN = os.environ.get("CLAUDE_BIN", "claude")
_TIMEOUT = int(os.environ.get("KOL_CC_TIMEOUT", "180"))


def _parse_json(text: str) -> dict:
    """从模型输出里抠出 JSON 对象（容忍 ```json 包裹、前后多余文字）。"""
    m = re.search(r"\{.*\}", text.strip(), re.S)
    if not m:
        raise ValueError(f"未从 Claude Code 输出里找到 JSON：{text[:200]}")
    return json.loads(m.group(0))


def _run(path: Path, instruction: str, model):
    keys = list(model.model_fields.keys())
    prompt = (
        f"Read the PDF file at this exact path: {path}\n\n"
        f"{instruction}\n\n"
        f"只输出一个 JSON 对象，键名严格为：{keys}。"
        "不要任何解释、不要 markdown 代码块，只要纯 JSON；缺的字段给 null 或空字符串/空数组。"
    )
    proc = subprocess.run(
        [
            CLAUDE_BIN, "-p", prompt,
            "--output-format", "json",
            "--allowedTools", "Read",
            "--dangerously-skip-permissions",
        ],
        capture_output=True, text=True, timeout=_TIMEOUT,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"claude CLI 失败（returncode={proc.returncode}）：{proc.stderr[:300]}")
    # --output-format json 返回一个信封，真正回答在 result 字段
    try:
        result_text = json.loads(proc.stdout).get("result", proc.stdout)
    except json.JSONDecodeError:
        result_text = proc.stdout
    return model.model_validate(_parse_json(result_text))


def extract_contract_cc(pdf_path: str | Path) -> Contract:
    return _run(Path(pdf_path), _CONTRACT_PROMPT, Contract)


def extract_approval_cc(source: str | Path) -> Approval:
    return _run(Path(source), _APPROVAL_PROMPT, Approval)
