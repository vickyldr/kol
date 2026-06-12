"""核对规则引擎。

把「审批单 ↔ 合同」逐条比对，输出 PASS / FAIL + 具体原因。
全部是纯函数、无外部依赖——给定相同输入永远得到相同结果，方便单元测试，
也保证金额这类算术绝不交给 AI 估算。

10 条检查 + 重复提交检测，对应用户给的清单：
  1. 项目是否与合同一致
  2. KOL 昵称是否与合同一致
  3. Ocean Look 必须对应 PayPal
  4. 账户名称是否与合同收款信息一致
  5. 币种是否与合同一致
  6. 审批金额 ÷ 合同单价 = 实际视频数（必须整除）
  7. 实际视频数 × 平台数 = 应填写合作视频数量
  8. 视频清单条数是否与合作视频数量一致
  9. 预付款流程单独标记
 10. 非 KOL 上线单独标记
"""

from __future__ import annotations

import unicodedata
from dataclasses import dataclass, field
from decimal import Decimal
from enum import Enum
from typing import List, Optional

from .models import Approval, Contract


class Status(str, Enum):
    PASS = "PASS"
    FAIL = "FAIL"
    FLAG = "FLAG"  # 不算失败，但需要人工单独留意（如预付款、非 KOL）


@dataclass
class CheckResult:
    name: str          # 这条检查叫什么
    status: Status     # PASS / FAIL / FLAG
    detail: str        # 具体说明（尤其失败原因）


@dataclass
class AuditResult:
    overall: Status            # 整体结论：任一 FAIL 即 FAIL
    checks: List[CheckResult] = field(default_factory=list)
    flags: List[CheckResult] = field(default_factory=list)  # 需人工留意的标记

    @property
    def reasons(self) -> List[str]:
        """所有未通过项的原因。"""
        return [f"{c.name}：{c.detail}" for c in self.checks if c.status is Status.FAIL]


def _norm(s: Optional[str]) -> str:
    """归一化字符串：去首尾空格、全角转半角、统一大小写。

    减少「USD」vs「usd」、全角空格、PayPal vs paypal 这类假性不一致。
    """
    if s is None:
        return ""
    s = unicodedata.normalize("NFKC", s)
    return s.strip().casefold()


def _edit_distance(a: str, b: str) -> int:
    """两个字符串的编辑距离（增删改各算 1 步），用于判断 KOL 昵称是否只差一点。"""
    m, n = len(a), len(b)
    prev = list(range(n + 1))
    for i in range(1, m + 1):
        cur = [i] + [0] * n
        for j in range(1, n + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
        prev = cur
    return prev[n]


def _near_integer(value: Decimal, tol: Decimal = Decimal("0.01")) -> Optional[int]:
    """若 value 足够接近某个整数则返回该整数，否则返回 None。

    用 Decimal 做金额除法避免二进制浮点误差。
    """
    nearest = value.to_integral_value(rounding="ROUND_HALF_UP")
    if abs(value - nearest) <= tol:
        return int(nearest)
    return None


# ---- 单条检查 -------------------------------------------------------------


def check_project(a: Approval, c: Contract) -> CheckResult:
    name = "1. 项目一致"
    # 很多合同正文不印项目名（例如只写要推广的 App 名），此时无法自动核对，
    # 转人工确认，而不是误判为失败。
    if not _norm(c.project):
        return CheckResult(
            name, Status.FLAG, f"合同里没写项目名，审批项目为「{a.project}」，请人工确认"
        )
    if _norm(a.project) == _norm(c.project):
        return CheckResult(name, Status.PASS, f"项目「{a.project}」与合同一致")
    return CheckResult(
        name, Status.FAIL, f"审批项目「{a.project}」≠ 合同项目「{c.project}」"
    )


def check_kol(a: Approval, c: Contract) -> CheckResult:
    name = "2. KOL 昵称一致"
    na, nc = _norm(a.kol_nickname), _norm(c.kol_nickname)
    if na == nc:
        return CheckResult(name, Status.PASS, f"KOL「{a.kol_nickname}」与合同一致")
    # 差一两个字母多半是合同/审批打字错，转人工看一眼，而不是直接打回
    if _edit_distance(na, nc) <= 2:
        return CheckResult(
            name,
            Status.FLAG,
            f"KOL 昵称差一点：审批「{a.kol_nickname}」vs 合同「{c.kol_nickname}」，疑似打字错，请人工确认",
        )
    return CheckResult(
        name,
        Status.FAIL,
        f"审批 KOL「{a.kol_nickname}」≠ 合同 KOL「{c.kol_nickname}」",
    )


def check_ocean_look_paypal(a: Approval, c: Contract) -> CheckResult:
    name = "3. Ocean Look 对应 PayPal"
    is_ocean = "ocean look" in _norm(a.product) or "ocean look" in _norm(a.project)
    if not is_ocean:
        return CheckResult(name, Status.PASS, "非 Ocean Look，规则不适用")
    # 审批收款方式 & 合同收款方式 任一明确，都必须是 PayPal
    methods = [m for m in (a.payment_method, c.payment_method) if m]
    if not methods:
        return CheckResult(
            name, Status.FAIL, "Ocean Look 项目但未填写收款方式，无法确认是否为 PayPal"
        )
    bad = [m for m in methods if "paypal" not in _norm(m)]
    if bad:
        return CheckResult(
            name,
            Status.FAIL,
            f"Ocean Look 必须用 PayPal，但收款方式为「{ '、'.join(bad) }」",
        )
    return CheckResult(name, Status.PASS, "Ocean Look 且收款方式为 PayPal")


def check_account_name(a: Approval, c: Contract) -> CheckResult:
    name = "4. 账户名称一致"
    if _norm(a.account_name) == _norm(c.account_name):
        return CheckResult(name, Status.PASS, f"账户名「{a.account_name}」与合同一致")
    return CheckResult(
        name,
        Status.FAIL,
        f"审批账户名「{a.account_name}」≠ 合同收款账户名「{c.account_name}」",
    )


def check_currency(a: Approval, c: Contract) -> CheckResult:
    name = "5. 币种一致"
    if _norm(a.currency) == _norm(c.currency):
        return CheckResult(name, Status.PASS, f"币种「{a.currency}」与合同一致")
    return CheckResult(
        name, Status.FAIL, f"审批币种「{a.currency}」≠ 合同币种「{c.currency}」"
    )


def compute_actual_videos(a: Approval, c: Contract) -> CheckResult:
    """检查 6：审批金额 ÷ 合同单价 = 实际视频数，必须整除。"""
    name = "6. 金额÷单价=整数视频数"
    if c.unit_price <= 0:
        return CheckResult(name, Status.FAIL, f"合同单价异常（{c.unit_price}），无法计算")
    quotient = Decimal(a.amount) / Decimal(c.unit_price)
    videos = _near_integer(quotient)
    if videos is None:
        return CheckResult(
            name,
            Status.FAIL,
            f"金额 {a.amount} ÷ 单价 {c.unit_price} = {quotient}，不是整数，无法对应整数条视频",
        )
    if videos <= 0:
        return CheckResult(name, Status.FAIL, f"算出的视频数为 {videos}，不合理")
    return CheckResult(
        name, Status.PASS, f"金额 {a.amount} ÷ 单价 {c.unit_price} = {videos} 条视频"
    )


def check_collab_count(a: Approval, actual_videos: Optional[int]) -> CheckResult:
    """检查 7：实际视频数 × 平台数 = 应填写合作视频数量。"""
    name = "7. 视频数×平台数=合作视频数量"
    if actual_videos is None:
        return CheckResult(name, Status.FAIL, "实际视频数无法计算（见检查 6），本项跳过")
    expected = actual_videos * a.platform_count
    if expected == a.collab_video_count:
        return CheckResult(
            name,
            Status.PASS,
            f"{actual_videos} 条 × {a.platform_count} 平台 = {expected}，与填写一致",
        )
    return CheckResult(
        name,
        Status.FAIL,
        f"应为 {actual_videos}×{a.platform_count}={expected}，但审批填的是 {a.collab_video_count}",
    )


def check_video_list(a: Approval) -> CheckResult:
    """检查 8：视频清单条数是否与合作视频数量一致。"""
    name = "8. 视频清单条数一致"
    n = len(a.video_list)
    if n == a.collab_video_count:
        return CheckResult(name, Status.PASS, f"视频清单 {n} 条，与合作视频数量一致")
    return CheckResult(
        name,
        Status.FAIL,
        f"视频清单 {n} 条 ≠ 合作视频数量 {a.collab_video_count}",
    )


def _norm_id(s: Optional[str]) -> str:
    """归一化收款标识：去空格/横线、转大写（IBAN/SWIFT/账号比对用）。"""
    if not s:
        return ""
    return "".join(s.split()).replace("-", "").upper()


def check_payment_details(a: Approval, c: Contract) -> CheckResult:
    """检查 11：具体收款标识（PayPal 邮箱 / IBAN / SWIFT / 账号）是否与合同一致。

    只比「账号本身」——名字对、账号被改成别人的，是最危险的错。
    两边都提供的标识才比对；任一不一致 → 打回；都没法比 → 人工确认。
    """
    name = "11. 收款信息核对"
    bad, ok = [], []

    # PayPal/Payoneer 邮箱（大小写不敏感）
    ae, ce = _norm(a.payment_email), _norm(c.payment_email)
    if ae and ce:
        (ok if ae == ce else bad).append(
            f"收款邮箱「{a.payment_email}」" if ae == ce
            else f"收款邮箱不一致：审批「{a.payment_email}」≠ 合同「{c.payment_email}」"
        )

    # IBAN / SWIFT / 银行账号（去空格横线后比对）
    for label, av, cv in (
        ("IBAN", a.iban, c.iban),
        ("SWIFT", a.swift, c.swift),
        ("银行账号", a.bank_account, c.bank_account),
    ):
        na, nc = _norm_id(av), _norm_id(cv)
        if na and nc:
            (ok if na == nc else bad).append(
                f"{label}「{av}」" if na == nc
                else f"{label}不一致：审批「{av}」≠ 合同「{cv}」"
            )

    if bad:
        return CheckResult(name, Status.FAIL, "；".join(bad))
    if ok:
        return CheckResult(name, Status.PASS, "收款信息一致（" + "、".join(ok) + "）")
    return CheckResult(
        name, Status.FLAG, "合同/审批未提供可比对的收款标识（邮箱/IBAN 等），请人工确认"
    )


def check_video_duplicates(a: Approval) -> CheckResult:
    """检查 8b：视频清单里的链接不能重复（同一链接贴两遍多半是漏填/错填）。"""
    name = "8b. 视频清单无重复链接"
    seen, dups = set(), []
    for v in a.video_list:
        key = _norm(v)
        if key and key in seen:
            dups.append(v)
        seen.add(key)
    if dups:
        return CheckResult(
            name, Status.FAIL, f"视频清单里有重复链接（贴了两遍）：{dups[0]}"
        )
    return CheckResult(name, Status.PASS, "视频清单无重复链接")


# ---- 总入口 ---------------------------------------------------------------


def audit(a: Approval, c: Contract) -> AuditResult:
    """跑完所有检查，汇总成一个结论。"""
    checks: List[CheckResult] = [
        check_project(a, c),
        check_kol(a, c),
        check_ocean_look_paypal(a, c),
        check_account_name(a, c),
        check_currency(a, c),
        check_payment_details(a, c),
    ]

    # 检查 6/7/8 是视频数量这条算术链。预付款时金额是部分付款，
    # 这条链不成立，整条单独标记交人工，不强行判 FAIL。
    if a.is_prepayment:
        checks.append(
            CheckResult("6-8. 视频数量核对", Status.FLAG, "预付款流程，金额为部分付款，视频数量核对跳过，请人工确认")
        )
    else:
        c6 = compute_actual_videos(a, c)
        checks.append(c6)
        actual_videos = None
        if c6.status is Status.PASS:
            actual_videos = int(Decimal(a.amount) / Decimal(c.unit_price))
        checks.append(check_collab_count(a, actual_videos))
        checks.append(check_video_list(a))
        checks.append(check_video_duplicates(a))

    # 检查 9/10：单独标记，不影响 PASS/FAIL
    flags: List[CheckResult] = []
    if a.is_prepayment:
        flags.append(CheckResult("9. 预付款", Status.FLAG, "本单为预付款流程，请单独走预付款审核"))
    if a.is_non_kol:
        flags.append(CheckResult("10. 非 KOL 上线", Status.FLAG, "本单为非 KOL 上线，请单独标记处理"))

    overall = Status.FAIL if any(ch.status is Status.FAIL for ch in checks) else Status.PASS
    return AuditResult(overall=overall, checks=checks, flags=flags)
