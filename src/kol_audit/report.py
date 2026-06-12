"""把核对结果排版成人一眼能看懂的文本报告。"""

from __future__ import annotations

from .dedup import DuplicateCheck
from .rules import AuditResult, Status

_ICON = {Status.PASS: "✅", Status.FAIL: "❌", Status.FLAG: "⚠️"}


def render(
    approval_id: str,
    dup: DuplicateCheck,
    result: AuditResult,
) -> str:
    lines = []
    lines.append(f"审批单 {approval_id} 核对报告")
    lines.append("=" * 40)

    # 重复提交单独置顶，因为这是最先要看的
    dup_icon = "❌" if dup.is_duplicate else "✅"
    lines.append(f"{dup_icon} 重复提交检测：{dup.detail}")
    lines.append("-" * 40)

    for ch in result.checks:
        lines.append(f"{_ICON[ch.status]} {ch.name}：{ch.detail}")

    if result.flags:
        lines.append("-" * 40)
        lines.append("需人工单独处理：")
        for fl in result.flags:
            lines.append(f"{_ICON[fl.status]} {fl.name}：{fl.detail}")

    lines.append("=" * 40)
    # 重复提交也算整体不通过
    overall = Status.FAIL if (dup.is_duplicate or result.overall is Status.FAIL) else Status.PASS
    lines.append(f"【结论】{_ICON[overall]} {overall.value}")
    if overall is Status.FAIL:
        lines.append("失败原因：")
        if dup.is_duplicate:
            lines.append(f"  - 重复提交：{dup.detail}")
        for r in result.reasons:
            lines.append(f"  - {r}")

    return "\n".join(lines)
