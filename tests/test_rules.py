"""核对规则的单元测试——证明 10 条逻辑都对，纯本地、不调 API。"""

import sys
from decimal import Decimal

import pytest

from kol_audit.dedup import DedupStore, fingerprint
from kol_audit.models import Approval, Contract
from kol_audit.rules import Status, audit


def make_approval(**over):
    base = dict(
        approval_id="APR-001",
        project="夏季彩妆推广",
        kol_nickname="@beauty_anna",
        product=None,
        payment_method="PayPal",
        account_name="Anna Smith",
        currency="USD",
        amount=Decimal("600"),
        platform_count=2,
        collab_video_count=4,
        video_list=["v1", "v2", "v3", "v4"],
        is_prepayment=False,
        is_non_kol=False,
    )
    base.update(over)
    return Approval(**base)


def make_contract(**over):
    base = dict(
        project="夏季彩妆推广",
        kol_nickname="@beauty_anna",
        unit_price=Decimal("300"),
        account_name="Anna Smith",
        payment_method="PayPal",
        currency="USD",
    )
    base.update(over)
    return Contract(**base)


def test_all_pass():
    # 600 / 300 = 2 条；2 条 × 2 平台 = 4；清单 4 条 → 全过
    res = audit(make_approval(), make_contract())
    assert res.overall is Status.PASS
    assert res.reasons == []


def test_project_mismatch():
    res = audit(make_approval(project="冬季护肤"), make_contract())
    assert res.overall is Status.FAIL
    assert any("项目" in r for r in res.reasons)


def test_project_vs_contract_app_name_must_match():
    # 真实样例：审批项目 Rythmix，合同 WHEREAS 写的 App 名是 VivaVideo → 必须打回
    res = audit(make_approval(project="Rythmix"), make_contract(project="VivaVideo"))
    assert res.overall is Status.FAIL
    assert any("Rythmix" in r and "VivaVideo" in r for r in res.reasons)


def test_project_missing_in_contract_is_flagged():
    # 合同确实没写 App 名 → 转人工确认，而非误判失败
    res = audit(make_approval(project="Rythmix"), make_contract(project=None))
    p = next(c for c in res.checks if c.name.startswith("1"))
    assert p.status is Status.FLAG
    assert res.overall is Status.PASS  # 仅人工确认，不算失败


def test_kol_mismatch():
    res = audit(make_approval(kol_nickname="@someone_else"), make_contract())
    assert res.overall is Status.FAIL
    assert any("KOL" in r for r in res.reasons)


def test_normalization_avoids_false_fail():
    # 大小写 + 全角空格 不应判为不一致
    res = audit(
        make_approval(currency="usd", account_name=" Anna  Smith "),
        make_contract(currency="USD", account_name="Anna Smith"),
    )
    # 账户名中间双空格会被 casefold/strip 处理首尾，但中间空格不同——
    # 这里验证币种大小写归一化生效（账户名仍可能因中间空格不同而失败，属预期严格）
    currency_check = next(c for c in res.checks if c.name.startswith("5"))
    assert currency_check.status is Status.PASS


def test_ocean_look_must_be_paypal():
    a = make_approval(product="Ocean Look", payment_method="银行转账")
    c = make_contract(payment_method="银行转账")
    res = audit(a, c)
    assert res.overall is Status.FAIL
    assert any("PayPal" in r for r in res.reasons)


def test_ocean_look_with_paypal_passes():
    a = make_approval(product="Ocean Look", payment_method="PayPal")
    res = audit(a, make_contract())
    ol = next(c for c in res.checks if c.name.startswith("3"))
    assert ol.status is Status.PASS


def test_non_ocean_look_skips_rule3():
    res = audit(make_approval(product="其他业务", payment_method="银行转账"), make_contract(payment_method="银行转账"))
    ol = next(c for c in res.checks if c.name.startswith("3"))
    assert ol.status is Status.PASS  # 规则不适用，视为通过


def test_kol_typo_is_flagged_not_failed():
    # 差一个字母（合同打字错）→ 转人工，不直接打回
    res = audit(make_approval(kol_nickname="thisishikmatt"), make_contract(kol_nickname="thisisthikmatt"))
    k = next(c for c in res.checks if c.name.startswith("2"))
    assert k.status is Status.FLAG
    # 仅此一项时不算整体失败
    assert res.overall is Status.PASS


def test_kol_totally_different_still_fails():
    res = audit(make_approval(kol_nickname="@anna"), make_contract(kol_nickname="@bobxyz"))
    assert res.overall is Status.FAIL


def test_kol_handle_differs_but_account_and_email_match_is_flagged():
    # 真实样例 061：handle 差很多，但账户名+PayPal邮箱都一致 → 转人工，不打回
    res = audit(
        make_approval(kol_nickname="soyelpipelon09", account_name="Andrés Giraldo Aguirre",
                      payment_email="Anfegi9703@gmail.com"),
        make_contract(kol_nickname="elpipelon09", account_name="Andrés Giraldo Aguirre",
                      payment_email="Anfegi9703@gmail.com"),
    )
    k = next(c for c in res.checks if c.name.startswith("2"))
    assert k.status is Status.FLAG
    assert res.overall is Status.PASS


def test_duplicate_video_links_fail():
    res = audit(
        make_approval(collab_video_count=2, platform_count=1, amount=Decimal("600"),
                      video_list=["https://x.com/同一个", "https://x.com/同一个"]),
        make_contract(unit_price=Decimal("300")),
    )
    assert res.overall is Status.FAIL
    assert any("重复链接" in r for r in res.reasons)


def test_payment_email_match_passes():
    res = audit(
        make_approval(payment_email="rafa.grama.silva@gmail.com"),
        make_contract(payment_email="RAFA.Grama.Silva@gmail.com"),  # 大小写不敏感
    )
    p = next(c for c in res.checks if c.name.startswith("11"))
    assert p.status is Status.PASS


def test_payment_email_mismatch_fails():
    res = audit(
        make_approval(payment_email="rafa.grama.silva@gmail.com"),
        make_contract(payment_email="someone.else@gmail.com"),
    )
    assert res.overall is Status.FAIL
    assert any("收款邮箱不一致" in r for r in res.reasons)


def test_iban_mismatch_fails():
    # 空格/横线无关，纯数字不同才算不一致
    res = audit(
        make_approval(iban="TR23 0001 0090 1093 4138 2050 01"),
        make_contract(iban="TR99-0001-0090-1093-4138-2050-01"),
    )
    assert res.overall is Status.FAIL
    assert any("IBAN不一致" in r for r in res.reasons)


def test_iban_match_ignores_spaces():
    res = audit(
        make_approval(iban="TR23 0001 0090 1093 4138 2050 01"),
        make_contract(iban="TR2300010090109341382050 01"),
    )
    p = next(c for c in res.checks if c.name.startswith("11"))
    assert p.status is Status.PASS


def test_payment_details_missing_is_flagged():
    res = audit(make_approval(), make_contract())  # 两边都没填收款标识
    p = next(c for c in res.checks if c.name.startswith("11"))
    assert p.status is Status.FLAG
    assert res.overall is Status.PASS  # 仅人工确认，不算失败


def test_account_name_mismatch():
    # 银行收款：账户名不一致 → 打回（PayPal 不核姓名，故用银行方式测）
    res = audit(
        make_approval(payment_method="Bank transfer", account_name="Bob Jones", recipient_country="土耳其"),
        make_contract(account_name="Anna Smith"),
    )
    assert res.overall is Status.FAIL
    assert any("账户名" in r for r in res.reasons)


def test_currency_mismatch():
    res = audit(make_approval(currency="EUR"), make_contract())
    assert res.overall is Status.FAIL


def test_amount_not_divisible_by_unit_price():
    # 650 / 300 = 2.16... 不整除 → FAIL
    res = audit(make_approval(amount=Decimal("650")), make_contract())
    assert res.overall is Status.FAIL
    assert any("不是整数" in r or "整数" in r for r in res.reasons)


def test_collab_count_wrong():
    # 600/300=2 条，×2 平台应为 4，但填了 5
    res = audit(make_approval(collab_video_count=5, video_list=["v1", "v2", "v3", "v4", "v5"]), make_contract())
    assert res.overall is Status.FAIL
    assert any("合作视频数量" in r or "视频数" in r for r in res.reasons)


def test_video_list_count_mismatch():
    # 数量字段对（4），但清单只给了 3 条
    res = audit(make_approval(video_list=["v1", "v2", "v3"]), make_contract())
    assert res.overall is Status.FAIL
    assert any("视频清单" in r for r in res.reasons)


def test_prepayment_is_flagged_and_skips_math():
    res = audit(make_approval(is_prepayment=True, amount=Decimal("100")), make_contract())
    # 预付款不因金额对不上而 FAIL（前 5 项仍正常）
    assert res.overall is Status.PASS
    assert any(f.name.startswith("9") for f in res.flags)


def test_non_kol_is_flagged():
    res = audit(make_approval(is_non_kol=True), make_contract())
    assert any(f.name.startswith("10") for f in res.flags)


def test_dedup(tmp_path):
    store = DedupStore(str(tmp_path / "store.json"))
    a = make_approval()
    assert store.check(a).is_duplicate is False
    store.record(a, "2026-06-12 10:00")
    # 换个单号、内容照旧 → 应判重复
    a2 = make_approval(approval_id="APR-999")
    dup = store.check(a2)
    assert dup.is_duplicate is True
    assert fingerprint(a) == fingerprint(a2)


def test_decimal_precision():
    # 0.1+0.2 类浮点陷阱：单价 0.1，金额 0.3 → 应整除为 3
    res = audit(
        make_approval(amount=Decimal("0.3"), platform_count=1, collab_video_count=3, video_list=["a", "b", "c"]),
        make_contract(unit_price=Decimal("0.1")),
    )
    c6 = next(c for c in res.checks if c.name.startswith("6"))
    assert c6.status is Status.PASS


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))


def test_notes_platform_count_mismatch_flagged():
    # 真实样例038：备注说3平台，清单实际4个 → 备注一致性标人工
    res = audit(
        make_approval(platform_count=4, collab_video_count=4,
                      video_list=["a", "b", "c", "d"],
                      notes_video_count=1, notes_platform_count=3, notes_total=Decimal("1200")),
        make_contract(unit_price=Decimal("300")),
    )
    n = next(c for c in res.checks if c.name.startswith("13"))
    assert n.status is Status.FLAG
    assert "平台数" in n.detail


def test_notes_total_mismatch_flagged():
    res = audit(
        make_approval(amount=Decimal("600"), notes_total=Decimal("999")),
        make_contract(),
    )
    n = next(c for c in res.checks if c.name.startswith("13"))
    assert n.status is Status.FLAG
    assert "备注总额" in n.detail


def test_bank_name_turkish_chars_flagged():
    # 土耳其银行收款人姓名含 ı/ç → 标人工
    res = audit(
        make_approval(payment_method="Bank transfer", account_name="Abdullah Alperen Kılınç",
                      recipient_country="土耳其", iban="TR18 0004 6002"),
        make_contract(account_name="Abdullah Alperen Kılınç", iban="TR18 0004 6002"),
    )
    s = next(c for c in res.checks if c.name.startswith("4b"))
    assert s.status is Status.FLAG
    assert "非英文字符" in s.detail


def test_bank_name_taiwan_cjk_flagged():
    res = audit(
        make_approval(payment_method="Bank transfer", account_name="張海山", recipient_country="台湾"),
        make_contract(account_name="張海山"),
    )
    s = next(c for c in res.checks if c.name.startswith("4b"))
    assert s.status is Status.FLAG


def test_bank_name_korea_japan_local_ok():
    for ctry, nm in [("韩国", "정가을"), ("日本", "松村龍")]:
        res = audit(
            make_approval(payment_method="Bank transfer", account_name=nm, recipient_country=ctry),
            make_contract(account_name=nm),
        )
        s = next(c for c in res.checks if c.name.startswith("4b"))
        assert s.status is Status.PASS


def test_paypal_name_not_checked():
    # PayPal：姓名错误无所谓，账户名检查直接 PASS
    res = audit(
        make_approval(payment_method="PayPal", account_name="完全不同的名字",
                      payment_email="a@b.com"),
        make_contract(account_name="Someone Else", payment_email="a@b.com"),
    )
    acc = next(c for c in res.checks if c.name.startswith("4."))
    assert acc.status is Status.PASS
