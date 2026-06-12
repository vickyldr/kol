"""飞书审批接入（预留接口）——这是「全自动机器人」差的最后一环。

⚠️ 现状：要让程序自动把每天的审批单和合同附件抓下来，必须由飞书
【管理员】在飞书开放平台后台建一个「企业自建应用」，并开通审批相关权限：
  - approval:approval          读取审批定义/实例
  - approval:approval.readonly 读取审批实例与表单内容
  - drive / docs 附件下载相关权限（用于把合同 PDF 下载下来）
拿到 App ID / App Secret 后，填进环境变量即可让下面的代码跑起来：
  FEISHU_APP_ID、FEISHU_APP_SECRET

拿到权限前，请用 kol_audit.cli 的「半自动模式」：手动下载合同 PDF +
审批截图，丢给引擎核对。核对逻辑完全一样，将来接上 API 不用改。

下面是接入骨架，标了 TODO 的地方在拿到权限后补全即可。
飞书审批 OpenAPI 文档：https://open.feishu.cn/document/server-docs/approval-v4/
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import List, Optional

FEISHU_BASE = "https://open.feishu.cn/open-apis"


@dataclass
class RawApprovalInstance:
    """飞书返回的一条审批实例（原始）。"""

    instance_code: str
    form: dict           # 表单字段
    attachments: List[str]  # 附件下载链接/文件 token


class FeishuApprovalClient:
    """飞书审批 API 封装。需要管理员开通自建应用权限后才能使用。"""

    def __init__(self, app_id: Optional[str] = None, app_secret: Optional[str] = None):
        self.app_id = app_id or os.environ.get("FEISHU_APP_ID")
        self.app_secret = app_secret or os.environ.get("FEISHU_APP_SECRET")
        if not self.app_id or not self.app_secret:
            raise RuntimeError(
                "缺少飞书应用凭证。请先让管理员建企业自建应用并开通审批权限，"
                "再设置环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET。"
                "在此之前请使用 kol_audit.cli 的半自动模式（手动喂 PDF + 截图）。"
            )

    def _tenant_access_token(self) -> str:
        """换取 tenant_access_token（应用维度令牌）。"""
        # TODO: POST {FEISHU_BASE}/auth/v3/tenant_access_token/internal
        #       body: {"app_id": ..., "app_secret": ...}
        raise NotImplementedError("拿到飞书权限后补全此处")

    def list_pending(self, approval_code: str) -> List[str]:
        """列出某审批定义下、当前用户待审批的实例编号。"""
        # TODO: 调用 approval 实例查询接口，筛选待我审批的单子
        raise NotImplementedError("拿到飞书权限后补全此处")

    def get_instance(self, instance_code: str) -> RawApprovalInstance:
        """拉取一条审批实例的表单 + 附件。"""
        # TODO: GET {FEISHU_BASE}/approval/v4/instances/{instance_code}
        raise NotImplementedError("拿到飞书权限后补全此处")

    def download_attachment(self, file_token: str, dest_path: str) -> str:
        """把合同附件下载到本地，返回本地路径。"""
        # TODO: 通过 drive/docs 下载接口把 PDF 存到 dest_path
        raise NotImplementedError("拿到飞书权限后补全此处")


def raw_to_approval(raw: RawApprovalInstance):
    """把飞书原始表单映射成 kol_audit.models.Approval。

    各家审批表单字段名不同，拿到一条真实样例后在这里做字段对应即可。
    """
    # TODO: 按贵司审批表单的实际字段名做映射
    raise NotImplementedError("拿到一条真实审批样例后，在这里把表单字段对应到 Approval")
