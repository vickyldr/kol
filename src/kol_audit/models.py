"""数据模型：审批单（Approval）与合同（Contract）。

这是整个核对引擎的「契约」——不管数据是人工录入、截图识别，还是将来飞书 API
自动抓取，最终都要落到这两个对象上，再交给 rules.py 做比对。
字段都用中文业务含义命名，方便对照飞书审批表单。
"""

from __future__ import annotations

from decimal import Decimal
from typing import List, Optional

from pydantic import BaseModel, Field


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

    is_prepayment: bool = Field(default=False, description="是否为预付款流程")
    is_non_kol: bool = Field(default=False, description="是否为非 KOL 上线")


class Contract(BaseModel):
    """审批里附的合同 PDF 中提取出来的关键字段。"""

    project: Optional[str] = Field(
        default=None, description="合同中的项目名称；很多合同正文不写项目名，留空即可"
    )
    kol_nickname: str = Field(description="合同中的 KOL 昵称")
    unit_price: Decimal = Field(description="合同单价（每条视频的价格）")
    account_name: str = Field(description="合同收款信息中的账户名称")
    payment_method: Optional[str] = Field(
        default=None, description="合同约定的收款方式，例如 PayPal"
    )
    currency: str = Field(description="合同币种")
