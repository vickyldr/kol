"""用 Claude 从合同 PDF / 审批截图里提取结构化字段。

注意分工：这里只负责「把图文读成字段」，绝不让模型做金额计算或下结论——
那些算术和判断在 rules.py 里用代码做，保证可靠、可复现。

需要环境变量 ANTHROPIC_API_KEY。
"""

from __future__ import annotations

import base64
from pathlib import Path

import anthropic

from .models import Approval, Contract

MODEL = "claude-opus-4-8"

_CONTRACT_PROMPT = """这是一份 KOL 合作合同。请从中提取以下字段，原样照抄合同里的内容，不要改写、不要计算：
- project: 合同 WHEREAS 条款里写的「要推广的 App 名」（如 VivaVideo），
           用于和审批的项目名做完全一致比对；注意不是甲方公司名（如 Quvideo）
- kol_nickname: KOL 昵称（红人名/账号名）
- party_b_legal_name: 合同「乙方（PARTY B INFORMATION）信息」里的 Legal Name / 法人名 / 名称
                      （红人的真实姓名/法定名称）。注意是乙方那一行，不是甲方 Quvideo。
                      如果合同里乙方 Legal Name 这一行确实是空的，就留空。
- unit_price: 单价（每条视频的价格，只要数字）
- account_name: 收款信息里的账户名称/收款人姓名
- payment_method: 收款方式（如 PayPal、银行转账等）
- currency: 币种（如 USD、CNY）
- payment_email: 合同收款信息里的 PayPal/Payoneer 邮箱（没有就留空）
- iban: 合同里的 IBAN（没有就留空）
- swift: 合同里的 SWIFT/BIC 码（没有就留空）
- bank_account: 合同里的银行账号（非 IBAN，没有就留空）
- recipient_country: 合同收款信息里的国家（Country of Bank Account，没有就留空）
- recipient_address: 合同收款信息里的收款方/账户持有人地址（没有就留空）
- postal_code: 合同收款信息里的邮编（没有就留空）
如果某字段合同里找不到，就根据上下文留空或填最接近的值。"""

_APPROVAL_PROMPT = """这是一张飞书付款审批单的截图/内容。请提取以下字段，原样照抄，不要计算：
- approval_id: 审批单号
- project: 项目
- kol_nickname: KOL 昵称
- product: 产品/业务线（如 Ocean Look），没有就留空
- payment_method: 收款方式（如 PayPal）
- account_name: 收款账户名称
- currency: 币种
- amount: 审批金额（只要数字）
- platform_count: 平台数
- collab_video_count: 填写的合作视频数量
- video_list: 视频清单（每条视频链接/标识放进数组）
- is_prepayment: 是否预付款/分期/尾款（true/false）。判断依据有两处，任一命中即 true：
    (1) 审批流程字段是「预付款流程」；
    (2) 备注里出现「预付款 / 已预支付 / 分期 / 尾款 / 支付剩余」等字样
        （有的单审批流程写"现付款"，但备注才点明是预付尾款，必须按备注判）
- is_non_kol: 是否非 KOL 上线（true/false）
- payment_email: 审批里的 PayPal/Payoneer 收款邮箱（没有就留空）
- iban: 审批里的国际银行账号 IBAN（没有就留空）
- swift: 审批里的 SWIFT/BIC（银行识别码，没有就留空）
- bank_account: 审批里的收款方银行账号（非 IBAN，没有就留空）
- recipient_country: 审批里的收款账户所在国家（没有就留空）
- recipient_address: 审批里的收款方地址（Address，没有就留空）
- postal_code: 审批里的邮编（Postal code，没有就留空）
- notes: 备注栏原文（完整照抄）
- notes_total: 备注里写的总额/合计金额（只要数字，如 300、499；没有就留空）
- notes_unit_price: 备注里写的视频单价（只要数字；没有就留空）
- notes_video_count: 备注里写的视频条数（如"1视频""共2条视频"，取本次条数；没有就留空）
- notes_platform_count: 备注里写的平台数（如"3平台""igtt双平台"=2、"igttyt"=3；没有就留空）
  注意：备注里的"X万""1.5万"等若是播放量/预估播放量，不要当成金额。"""


def _pdf_block(path: str | Path) -> dict:
    data = base64.standard_b64encode(Path(path).read_bytes()).decode("utf-8")
    return {
        "type": "document",
        "source": {"type": "base64", "media_type": "application/pdf", "data": data},
    }


def _image_block(path: str | Path) -> dict:
    p = Path(path)
    ext = p.suffix.lower().lstrip(".")
    media = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "webp": "image/webp"}.get(
        ext, "image/png"
    )
    data = base64.standard_b64encode(p.read_bytes()).decode("utf-8")
    return {"type": "image", "source": {"type": "base64", "media_type": media, "data": data}}


def extract_contract(pdf_path: str | Path, client: anthropic.Anthropic | None = None) -> Contract:
    """从合同 PDF 提取 Contract。"""
    client = client or anthropic.Anthropic()
    resp = client.messages.parse(
        model=MODEL,
        max_tokens=2048,
        messages=[
            {"role": "user", "content": [_pdf_block(pdf_path), {"type": "text", "text": _CONTRACT_PROMPT}]}
        ],
        output_format=Contract,
    )
    return resp.parsed_output


def extract_approval(source: str | Path, client: anthropic.Anthropic | None = None) -> Approval:
    """从审批单来源提取 Approval。

    source 可以是：审批截图（png/jpg）、审批导出的 PDF，或一段纯文字（直接传字符串内容）。
    """
    client = client or anthropic.Anthropic()

    content: list
    p = Path(str(source))
    if p.exists() and p.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}:
        content = [_image_block(p), {"type": "text", "text": _APPROVAL_PROMPT}]
    elif p.exists() and p.suffix.lower() == ".pdf":
        content = [_pdf_block(p), {"type": "text", "text": _APPROVAL_PROMPT}]
    else:
        # 当成纯文字内容处理
        content = [{"type": "text", "text": f"{_APPROVAL_PROMPT}\n\n审批内容：\n{source}"}]

    resp = client.messages.parse(
        model=MODEL,
        max_tokens=2048,
        messages=[{"role": "user", "content": content}],
        output_format=Approval,
    )
    return resp.parsed_output
