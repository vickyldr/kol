"""批量核对：一次核多单。

输入：一堆审批 + 一堆合同（结构化 JSON）。
做的事：
  1. 自动把每份审批和它对应的合同**配对**（按 KOL 昵称 / 收款账户名）
  2. 逐单跑核对引擎
  3. 跨单做重复提交检测
  4. 输出一张可扫读的汇总表：哪单 PASS、哪单打回、原因是什么

命令行用法（离线，喂两个子目录 approvals/ 和 contracts/）：
    PYTHONPATH=src python -m kol_audit.batch --dir 某文件夹
其中 某文件夹/approvals/*.json 放审批，某文件夹/contracts/*.json 放合同。
"""

from __future__ import annotations

import argparse
import datetime as _dt
import glob
import json
import os
from dataclasses import dataclass
from typing import List, Optional, Tuple

from .dedup import DedupStore, DuplicateCheck
from .models import Approval, Contract
from .rules import AuditResult, Status, audit


def _norm(s: Optional[str]) -> str:
    return (s or "").strip().casefold()


def match_contract(a: Approval, contracts: List[Contract]) -> Optional[Contract]:
    """给一份审批找它对应的合同。

    先按 KOL 昵称配，配不上再按收款账户名配。都配不上返回 None。
    """
    for c in contracts:
        if _norm(a.kol_nickname) and _norm(a.kol_nickname) == _norm(c.kol_nickname):
            return c
    for c in contracts:
        if _norm(a.account_name) and _norm(a.account_name) == _norm(c.account_name):
            return c
    return None


@dataclass
class BatchItem:
    approval: Approval
    contract: Optional[Contract]
    dup: Optional[DuplicateCheck]
    result: Optional[AuditResult]
    overall: Status            # 这一单的最终结论
    note: str = ""             # 异常说明（如找不到合同）


def run_batch(
    approvals: List[Approval],
    contracts: List[Contract],
    store: Optional[DedupStore] = None,
    record: bool = False,
) -> List[BatchItem]:
    items: List[BatchItem] = []
    seen_at = _dt.datetime.now().strftime("%Y-%m-%d %H:%M")

    for a in approvals:
        c = match_contract(a, contracts)
        dup = store.check(a) if store else None

        if c is None:
            items.append(
                BatchItem(a, None, dup, None, Status.FAIL, note="找不到对应合同，无法核对")
            )
            continue

        result = audit(a, c)
        overall = result.overall
        if dup and dup.is_duplicate:
            overall = Status.FAIL  # 重复提交也算打回

        items.append(BatchItem(a, c, dup, result, overall))

        if store and record and not (dup and dup.is_duplicate):
            store.record(a, seen_at)

    return items


def render_batch(items: List[BatchItem]) -> str:
    n = len(items)
    n_pass = sum(1 for it in items if it.overall is Status.PASS)
    n_fail = sum(1 for it in items if it.overall is Status.FAIL)

    lines = []
    lines.append(f"批量核对结果（共 {n} 单）")
    lines.append("=" * 50)
    lines.append(f"✅ 通过 {n_pass} 单    ❌ 打回 {n_fail} 单")
    lines.append("-" * 50)

    # 先列要打回的，最需要你处理
    def sort_key(it: BatchItem):
        return 0 if it.overall is Status.FAIL else 1

    for it in sorted(items, key=sort_key):
        icon = "✅" if it.overall is Status.PASS else "❌"
        who = f"{it.approval.project}/{it.approval.kol_nickname}"
        head = f"{icon} {it.approval.approval_id}  {who}"
        lines.append(head)
        if it.overall is Status.FAIL:
            reasons = []
            if it.dup and it.dup.is_duplicate:
                reasons.append("重复提交")
            if it.note:
                reasons.append(it.note)
            if it.result:
                reasons.extend(it.result.reasons)
            for r in reasons:
                lines.append(f"     ↳ {r}")
        # 人工标记（预付款 / 非 KOL / 项目待确认）也提示出来
        if it.result:
            for fl in it.result.flags:
                lines.append(f"     ⚠️ {fl.name}：{fl.detail}")

    lines.append("=" * 50)
    return "\n".join(lines)


def _load_dir(path: str, model):
    out = []
    for fp in sorted(glob.glob(os.path.join(path, "*.json"))):
        with open(fp, "r", encoding="utf-8") as f:
            out.append(model.model_validate(json.load(f)))
    return out


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="KOL 付款审批 批量核对")
    parser.add_argument(
        "--dir", required=True, help="含 approvals/ 和 contracts/ 两个子目录的文件夹"
    )
    parser.add_argument("--dedup-store", default="processed_approvals.json")
    parser.add_argument("--record", action="store_true", help="把本批计入重复检测记录")
    args = parser.parse_args(argv)

    approvals = _load_dir(os.path.join(args.dir, "approvals"), Approval)
    contracts = _load_dir(os.path.join(args.dir, "contracts"), Contract)
    store = DedupStore(args.dedup_store)

    items = run_batch(approvals, contracts, store, record=args.record)
    print(render_batch(items))

    return 1 if any(it.overall is Status.FAIL for it in items) else 0


if __name__ == "__main__":
    raise SystemExit(main())
