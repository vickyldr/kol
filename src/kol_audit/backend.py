"""识别后端选择器：根据环境变量决定用「Claude Code 订阅」还是「Anthropic API」。

- KOL_BACKEND=claude_code → 用 Claude Code 无头模式（需 CLAUDE_CODE_OAUTH_TOKEN）
- KOL_BACKEND=api         → 用 Anthropic API（需 ANTHROPIC_API_KEY）
- 不设时：有 CLAUDE_CODE_OAUTH_TOKEN 而没有 ANTHROPIC_API_KEY → 自动走 claude_code；
          否则走 api。

web/server.py 用这里的 extract_approval / extract_contract，切后端不用改别处。
"""

from __future__ import annotations

import os

from .models import Approval, Contract


def _use_claude_code() -> bool:
    choice = os.environ.get("KOL_BACKEND", "").strip().lower()
    if choice == "claude_code":
        return True
    if choice == "api":
        return False
    # 自动判断：有订阅 token、没 API key → 走 Claude Code
    return bool(os.environ.get("CLAUDE_CODE_OAUTH_TOKEN")) and not os.environ.get("ANTHROPIC_API_KEY")


def extract_approval(source) -> Approval:
    if _use_claude_code():
        from .extract_cc import extract_approval_cc
        return extract_approval_cc(source)
    from .extract import extract_approval as _f
    return _f(source)


def extract_contract(pdf_path) -> Contract:
    if _use_claude_code():
        from .extract_cc import extract_contract_cc
        return extract_contract_cc(pdf_path)
    from .extract import extract_contract as _f
    return _f(pdf_path)
