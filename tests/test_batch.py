"""批量核对的单测。"""

from decimal import Decimal

from kol_audit.batch import match_contract, render_batch, run_batch
from kol_audit.models import Approval, Contract
from kol_audit.rules import Status


def appr(**over):
    base = dict(
        approval_id="A1", project="VivaVideo", kol_nickname="@anna",
        payment_method="PayPal", account_name="Anna Smith", currency="USD",
        amount=Decimal("600"), platform_count=2, collab_video_count=4,
        video_list=["1", "2", "3", "4"], is_prepayment=False, is_non_kol=False,
    )
    base.update(over)
    return Approval(**base)


def con(**over):
    base = dict(
        project="VivaVideo", kol_nickname="@anna", unit_price=Decimal("300"),
        account_name="Anna Smith", payment_method="PayPal", currency="USD",
    )
    base.update(over)
    return Contract(**base)


def test_match_by_kol():
    a = appr(kol_nickname="@bob")
    cs = [con(kol_nickname="@anna"), con(kol_nickname="@bob", account_name="Bob")]
    assert match_contract(a, cs)[0] is cs[1]


def test_match_by_account_when_kol_differs():
    a = appr(kol_nickname="bob123", account_name="Bob Jones")
    cs = [con(kol_nickname="someoneelse", account_name="Bob Jones")]
    assert match_contract(a, cs)[0] is cs[0]


def test_no_match_returns_none():
    assert match_contract(appr(kol_nickname="x", account_name="y"), [con()])[0] is None


def test_batch_mixes_pass_fail_and_missing():
    approvals = [
        appr(approval_id="OK"),                                  # 干净 → PASS
        appr(approval_id="BAD", project="Rythmix"),              # 项目对不上 → FAIL
        appr(approval_id="LOST", kol_nickname="@ghost", account_name="Ghost"),  # 无合同
    ]
    contracts = [con()]  # 只有 @anna 的合同
    items = run_batch(approvals, contracts)
    by_id = {it.approval.approval_id: it for it in items}
    assert by_id["OK"].overall is Status.PASS
    assert by_id["BAD"].overall is Status.FAIL
    assert by_id["LOST"].overall is Status.FAIL
    assert "找不到对应合同" in by_id["LOST"].note
    # 汇总文本里该出现统计
    txt = render_batch(items)
    assert "共 3 单" in txt and "通过 1 单" in txt and "打回 2 单" in txt


def test_same_kol_two_contracts_pairs_by_project():
    from decimal import Decimal
    from kol_audit.models import Approval, Contract
    from kol_audit.batch import match_contract
    a = Approval(approval_id="X", project="Recco", kol_nickname="koala",
                 account_name="N", currency="USD", amount=Decimal("300"),
                 platform_count=1, collab_video_count=1, video_list=["v"])
    c_va = Contract(project="VivaVideo", kol_nickname="koala", party_b_legal_name="N",
                    unit_price=Decimal("300"), account_name="N", currency="USD")
    c_rc = Contract(project="Recco", kol_nickname="koala", party_b_legal_name="N",
                    unit_price=Decimal("300"), account_name="N", currency="USD")
    chosen, note = match_contract(a, [c_va, c_rc])
    assert chosen.project == "Recco"      # 按项目配对到正确那份
    assert "2 份合同" in note               # 且提示有多份、要人工确认


def test_same_kol_two_contracts_neither_matches_project_flags():
    from decimal import Decimal
    from kol_audit.models import Approval, Contract
    from kol_audit.batch import match_contract
    a = Approval(approval_id="X", project="Rythmix", kol_nickname="koala",
                 account_name="N", currency="USD", amount=Decimal("300"),
                 platform_count=1, collab_video_count=1, video_list=["v"])
    c_va = Contract(project="VivaVideo", kol_nickname="koala", party_b_legal_name="N",
                    unit_price=Decimal("300"), account_name="N", currency="USD")
    c_rc = Contract(project="Recco", kol_nickname="koala", party_b_legal_name="N",
                    unit_price=Decimal("300"), account_name="N", currency="USD")
    chosen, note = match_contract(a, [c_va, c_rc])
    assert "配对不确定" in note            # 定不出唯一 → 强制人工
