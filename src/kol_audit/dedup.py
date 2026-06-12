"""重复提交检测。

把每张处理过的审批单的「指纹」记到本地文件里。下次来一张，
先算指纹，命中过往记录就提示「疑似重复提交」。

指纹 = 项目 + KOL + 收款账户 + 金额 + 币种 的组合哈希。
故意不含 approval_id——因为实习生重复提交往往是换了个单号、内容照旧。
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from typing import Optional

from .models import Approval


def fingerprint(a: Approval) -> str:
    """内容指纹：同样的付款内容 → 同样的指纹。"""
    raw = "|".join(
        [
            a.project.strip().casefold(),
            a.kol_nickname.strip().casefold(),
            a.account_name.strip().casefold(),
            str(a.amount),
            a.currency.strip().casefold(),
        ]
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


@dataclass
class DuplicateCheck:
    is_duplicate: bool
    detail: str
    first_seen_id: Optional[str] = None


class DedupStore:
    """本地 JSON 记录已处理过的审批指纹。"""

    def __init__(self, path: str = "processed_approvals.json"):
        self.path = path
        self._data: dict = {}
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as f:
                self._data = json.load(f)

    def check(self, a: Approval) -> DuplicateCheck:
        fp = fingerprint(a)
        if fp in self._data:
            prev = self._data[fp]
            return DuplicateCheck(
                is_duplicate=True,
                detail=(
                    f"疑似重复提交：相同的项目/KOL/账户/金额/币种 已在 "
                    f"{prev.get('seen_at', '?')} 处理过（单号 {prev.get('approval_id', '?')}）"
                ),
                first_seen_id=prev.get("approval_id"),
            )
        return DuplicateCheck(is_duplicate=False, detail="未发现重复提交")

    def record(self, a: Approval, seen_at: str) -> None:
        """登记本单，供后续比对。"""
        self._data[fingerprint(a)] = {
            "approval_id": a.approval_id,
            "seen_at": seen_at,
        }
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump(self._data, f, ensure_ascii=False, indent=2)
