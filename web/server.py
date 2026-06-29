"""网页版：把一整堆 PDF（审批 + 合同）一次拖进去 → 自动配对 → 出一张总表。

解决「聊天框一次只能传 5 个、特别慢」的问题：这里一次拖几百个文件都行。

流程（每个文件都会走，漏不掉）：
  1. 本地读 PDF 文字，判断是「审批单」还是「合同」；
  2. 用提取后端把它读成结构化字段（extract.py）；
  3. 按 KOL 自动配对审批↔合同；
  4. 逐单跑【强制完整】核对引擎（漏任何一条规则就报错，出不来结果）；
  5. 返回一张可扫读的网页报表（含每单的全部规则明细）。

运行：
    pip install -r requirements.txt
    export ANTHROPIC_API_KEY=...        # 或换成公司内部 OCR/私有模型，见数据安全评估
    uvicorn web.server:app --host 0.0.0.0 --port 8000
然后浏览器打开 http://localhost:8000 ，把文件拖进去即可。

提取后端可替换：默认用 extract.py（Claude）。要全程不出内网，把 _extract_*
换成公司内部 OCR/私有模型即可，核对逻辑零改动。
"""

from __future__ import annotations

import io
import sys
from pathlib import Path

# 让 web/ 能 import 到 src/kol_audit
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

import os
import secrets

import fitz  # PyMuPDF：仅用于本地判断"审批 or 合同"，不外发
from fastapi import Depends, FastAPI, HTTPException, UploadFile, status
from fastapi.responses import HTMLResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials

from kol_audit.backend import extract_approval, extract_contract
from kol_audit.batch import run_batch
from kol_audit.dedup import DedupStore
from kol_audit.rules import Status

app = FastAPI(title="KOL 付款审批自动核对")

_INDEX = Path(__file__).resolve().parent / "index.html"

# ---- 访问密码（财务数据，别裸奔在公网）----
# 部署时设环境变量 ACCESS_USER / ACCESS_PASSWORD 即开启登录；不设则不拦（仅本地用）。
_AUTH_USER = os.environ.get("ACCESS_USER", "")
_AUTH_PW = os.environ.get("ACCESS_PASSWORD", "")
_basic = HTTPBasic(auto_error=False)


def require_login(cred: HTTPBasicCredentials | None = Depends(_basic)) -> None:
    if not _AUTH_PW:  # 没设密码 = 不拦（本地自用）
        return
    ok = (
        cred is not None
        and secrets.compare_digest(cred.username, _AUTH_USER)
        and secrets.compare_digest(cred.password, _AUTH_PW)
    )
    if not ok:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="需要登录",
            headers={"WWW-Authenticate": "Basic"},
        )


def _is_approval(pdf_bytes: bytes) -> bool:
    """本地读文字判断是不是审批单（看"小额付款申请"标记），不外发。"""
    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        head = "".join(p.get_text() for p in doc)[:80]
        return "小额付款申请" in head
    except Exception:
        return False


@app.get("/", response_class=HTMLResponse)
def index(_: None = Depends(require_login)) -> str:
    return _INDEX.read_text(encoding="utf-8")


@app.post("/audit", response_class=HTMLResponse)
async def audit_files(files: list[UploadFile], _: None = Depends(require_login)) -> str:
    approvals, contracts, errors = [], [], []
    for f in files:
        data = await f.read()
        try:
            if _is_approval(data):
                approvals.append(extract_approval(_as_pdf(data, f.filename)))
            else:
                contracts.append(extract_contract(_as_pdf(data, f.filename)))
        except Exception as e:  # 提取失败也要显式报出来，绝不静默跳过
            errors.append(f"{f.filename}: 读取失败 {e}")

    store = DedupStore("processed_approvals.json")
    items = run_batch(approvals, contracts, store, record=False)
    return _render_html(items, errors)


def _as_pdf(data: bytes, name: str) -> Path:
    """extract.py 接收路径；把上传内容落到临时文件再传入。"""
    import tempfile

    p = Path(tempfile.gettempdir()) / f"_kol_{abs(hash(name)) % 10**8}.pdf"
    p.write_bytes(data)
    return p


def _render_html(items, errors) -> str:
    n = len(items)
    n_fail = sum(1 for it in items if it.overall is Status.FAIL)
    n_pass = sum(1 for it in items if it.overall is Status.PASS)
    rows = []
    color = {Status.PASS: "#e8f5e9", Status.FAIL: "#ffebee", Status.FLAG: "#fff8e1"}
    icon = {Status.PASS: "✅ 通过", Status.FAIL: "❌ 打回", Status.FLAG: "⚠️ 人工"}
    # 打回的排最前
    for it in sorted(items, key=lambda x: 0 if x.overall is Status.FAIL else 1):
        detail = []
        if it.result:
            for ch in it.result.checks + it.result.flags:
                if ch.status is not Status.PASS:
                    detail.append(f"{ch.name}：{ch.detail}")
        if it.dup and it.dup.is_duplicate:
            detail.insert(0, "重复提交")
        if it.note:
            detail.insert(0, it.note)
        proj = f"{it.approval.project} / {it.approval.kol_nickname}"
        rows.append(
            f"<tr style='background:{color.get(it.overall, '#fff')}'>"
            f"<td>{it.approval.approval_id}</td><td>{proj}</td>"
            f"<td><b>{icon.get(it.overall, it.overall)}</b></td>"
            f"<td>{'<br>'.join(detail) or '—'}</td></tr>"
        )
    err_html = ""
    if errors:
        err_html = "<h3>⚠️ 这些文件没读出来（请重传/确认）</h3><ul>" + "".join(
            f"<li>{e}</li>" for e in errors) + "</ul>"
    return f"""<!doctype html><meta charset=utf-8>
<title>核对结果</title>
<style>body{{font-family:sans-serif;max-width:1100px;margin:24px auto}}
table{{border-collapse:collapse;width:100%}}td,th{{border:1px solid #ddd;padding:8px;font-size:14px}}
th{{background:#fafafa}}</style>
<h2>核对结果：共 {n} 单　✅ {n_pass}　❌ {n_fail}</h2>
{err_html}
<table><tr><th>单号</th><th>项目/KOL</th><th>结论</th><th>原因 / 需人工项</th></tr>
{''.join(rows)}</table>
<p><a href="/">← 再传一批</a></p>"""
