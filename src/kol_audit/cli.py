"""命令行入口。

用法一（接 Claude，自动读 PDF/截图）：
    export ANTHROPIC_API_KEY=...
    python -m kol_audit.cli --approval 审批截图.png --contract 合同.pdf

用法二（离线，直接喂结构化 JSON，不调 API，方便核对逻辑/测试）：
    python -m kol_audit.cli --approval-json a.json --contract-json c.json
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import sys

from .dedup import DedupStore
from .models import Approval, Contract
from .report import render
from .rules import Status, audit


def _load_json(path: str, model):
    with open(path, "r", encoding="utf-8") as f:
        return model.model_validate(json.load(f))


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="KOL 付款审批自动核对")
    parser.add_argument("--approval", help="审批来源：截图(png/jpg) / 审批PDF / 纯文字")
    parser.add_argument("--contract", help="合同 PDF 路径")
    parser.add_argument("--approval-json", help="离线模式：审批结构化 JSON")
    parser.add_argument("--contract-json", help="离线模式：合同结构化 JSON")
    parser.add_argument(
        "--dedup-store", default="processed_approvals.json", help="重复检测记录文件"
    )
    parser.add_argument(
        "--no-record", action="store_true", help="只核对、不把本单计入重复检测记录"
    )
    args = parser.parse_args(argv)

    if args.approval_json and args.contract_json:
        approval = _load_json(args.approval_json, Approval)
        contract = _load_json(args.contract_json, Contract)
    elif args.approval and args.contract:
        # 延迟 import，避免离线模式也要求装 anthropic
        from .extract import extract_approval, extract_contract

        print("正在读取合同 PDF……", file=sys.stderr)
        contract = extract_contract(args.contract)
        print("正在读取审批内容……", file=sys.stderr)
        approval = extract_approval(args.approval)
    else:
        parser.error("请提供 (--approval 和 --contract) 或 (--approval-json 和 --contract-json)")
        return 2

    store = DedupStore(args.dedup_store)
    dup = store.check(approval)
    result = audit(approval, contract)

    print(render(approval.approval_id, dup, result))

    if not args.no_record and not dup.is_duplicate:
        store.record(approval, _dt.datetime.now().strftime("%Y-%m-%d %H:%M"))

    failed = dup.is_duplicate or result.overall is Status.FAIL
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
