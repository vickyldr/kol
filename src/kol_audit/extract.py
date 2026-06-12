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
- project: 项目名称
- kol_nickname: KOL 昵称（红人名/账号名）
- unit_price: 单价（每条视频的价格，只要数字）
- account_name: 收款信息里的账户名称/收款人姓名
- payment_method: 收款方式（如 PayPal、银行转账等）
- currency: 币种（如 USD、CNY）
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
- is_prepayment: 是否预付款流程（true/false）
- is_non_kol: 是否非 KOL 上线（true/false）"""


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
