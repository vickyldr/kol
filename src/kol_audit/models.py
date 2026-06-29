"""数据模型：审批单（Approval）与合同（Contract）。

这是整个核对引擎的「契约」——不管数据是人工录入、截图识别，还是将来飞书 API
自动抓取，最终都要落到这两个对象上，再交给 rules.py 做比对。
字段都用中文业务含义命名，方便对照飞书审批表单。
"""

from __future__ import annotations

import re
from decimal import Decimal
from typing import List, Optional

from pydantic import BaseModel, Field, field_validator


def _num_str(v):
    """把 '5000TL' / 'USD300' / '35,000円' / '2,500.00' 这种带币种/逗号的值抠出纯数字。

    识别后端偶尔会把币种符号也塞进数字字段，这里统一清洗，避免整条读取失败。
    """
    if v is None or isinstance(v, (int, float, Decimal)):
        return v
    s = str(v).replace(",", "").replace("，", "")
    m = re.search(r"-?\d+(?:\.\d+)?", s)
    return m.group(0) if m else v


class Approval(BaseModel):
    """实习生在飞书里提交的付款审批单内容。"""

    approval_id: str = Field(description="审批单号/唯一标识，用于重复提交检测")

    project: str = Field(description="项目名称")
    kol_nickname: str = Field(description="KOL 昵称")

    # Ocean Look 这类「产品/业务线」字段，用于规则 3 的判断
    product: Optional[str] = Field(default=None, description="产品/业务线，例如 Ocean Look")

    payment_method: Optional[str] = Field(
        default=None, description="收款方式，例如 PayPal / 银行转账"
    )
    account_name: str = Field(description="收款账户名称")
    currency: str = Field(description="币种，例如 USD / CNY")

    amount: Decimal = Field(description="审批金额（本次付款总额）")
    platform_count: int = Field(description="平台数（同一条视频要上几个平台）")

    collab_video_count: int = Field(description="审批单里填写的「合作视频数量」")
    video_list: List[str] = Field(
        default_factory=list, description="视频清单，每条是一个视频链接/标识"
    )
    platforms: List[str] = Field(
        default_factory=list,
        description="视频清单里每条的「投放平台」，如 Instagram / TikTok / Youtube / 其他",
    )

    online_type: Optional[str] = Field(
        default=None, description="上线类型原文，如 KOL上线 / 社媒采买 / SEO上线 / 非KOL上线"
    )
    is_prepayment: bool = Field(default=False, description="是否为预付款流程")
    is_non_kol: bool = Field(default=False, description="是否为非 KOL 上线")

    # 具体收款标识（账号本身，不只是名字），用于「收款信息核对」
    payment_email: Optional[str] = Field(
        default=None, description="PayPal/Payoneer 收款邮箱"
    )
    iban: Optional[str] = Field(default=None, description="国际银行账号 IBAN")
    swift: Optional[str] = Field(default=None, description="银行 SWIFT/BIC 码")
    bank_account: Optional[str] = Field(default=None, description="银行账号（非 IBAN）")
    recipient_country: Optional[str] = Field(default=None, description="收款账户所在国家")
    recipient_address: Optional[str] = Field(default=None, description="收款方地址")
    postal_code: Optional[str] = Field(default=None, description="收款方邮编")

    # 备注栏原文 + 从备注里读出的成交数字，用于「备注一致性核对」
    notes: Optional[str] = Field(default=None, description="备注栏原文")
    notes_total: Optional[Decimal] = Field(default=None, description="备注里写的总额/合计金额")
    notes_unit_price: Optional[Decimal] = Field(default=None, description="备注里写的视频单价")
    notes_video_count: Optional[int] = Field(default=None, description="备注里写的视频条数")
    notes_platform_count: Optional[int] = Field(default=None, description="备注里写的平台数")

    @field_validator("amount", mode="before")
    @classmethod
    def _clean_amount(cls, v):
        return _num_str(v)

    @field_validator("platform_count", "collab_video_count", mode="before")
    @classmethod
    def _clean_required_int(cls, v):
        v = _num_str(v)
        return 0 if v in (None, "") else v

    @field_validator(
        "notes_total", "notes_unit_price", "notes_video_count", "notes_platform_count",
        mode="before",
    )
    @classmethod
    def _clean_optional_num(cls, v):
        return None if v in (None, "") else _num_str(v)


class Contract(BaseModel):
    """审批里附的合同 PDF 中提取出来的关键字段。"""

    project: Optional[str] = Field(
        default=None,
        description=(
            "合同 WHEREAS 条款里要推广的 App 名（如 VivaVideo），"
            "用于和审批项目名做完全一致比对；不是甲方公司名。"
            "若合同确实没写则留空（核对时转人工确认）。"
        ),
    )
    kol_nickname: str = Field(description="合同中的 KOL 昵称")
    party_b_legal_name: Optional[str] = Field(
        default=None,
        description=(
            "合同「乙方（Party B）信息」里的 Legal Name / 法人名 / 名称（红人的真实姓名/法定名称）。"
            "这一行必须填写；若合同里这一行确实空着则留空，核对时会标记出来。"
        ),
    )
    unit_price: Decimal = Field(description="合同单价（每条视频的价格）")

    @field_validator("unit_price", mode="before")
    @classmethod
    def _clean_unit_price(cls, v):
        return _num_str(v)

    account_name: str = Field(description="合同收款信息中的账户名称")
    payment_method: Optional[str] = Field(
        default=None, description="合同约定的收款方式，例如 PayPal"
    )
    currency: str = Field(description="合同币种")

    # 合同收款信息里的具体收款标识，用于「收款信息核对」
    payment_email: Optional[str] = Field(
        default=None, description="合同里的 PayPal/Payoneer 收款邮箱"
    )
    iban: Optional[str] = Field(default=None, description="合同里的 IBAN")
    swift: Optional[str] = Field(default=None, description="合同里的 SWIFT/BIC 码")
    bank_account: Optional[str] = Field(default=None, description="合同里的银行账号（非 IBAN）")
    recipient_country: Optional[str] = Field(default=None, description="合同里的收款账户所在国家")
    recipient_address: Optional[str] = Field(default=None, description="合同里的收款方地址")
    postal_code: Optional[str] = Field(default=None, description="合同里的收款方邮编")
