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

import sys
from pathlib import Path

# 让 web/ 能 import 到 src/kol_audit
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

import hashlib
import os
import secrets
import shutil
import tempfile
import threading
import uuid
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed

import fitz  # PyMuPDF：仅用于本地判断"审批 or 合同"，不外发
from fastapi import Depends, FastAPI, Form, HTTPException, UploadFile, status
from fastapi.responses import HTMLResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials

from kol_audit.backend import extract_approval, extract_contract
from kol_audit.batch import run_batch
from kol_audit.dedup import DedupStore
from kol_audit.models import Approval, Contract
from kol_audit.rules import Status

app = FastAPI(title="KOL 付款审批自动核对")

# 后台任务表：一次上传 = 一个 job，后台慢慢跑，页面轮询进度，避免 HTTP 超时。
_JOBS: dict[str, dict] = {}
_JOBS_LOCK = threading.Lock()
# 并发提取：多少个文件同时读（路 A 每个起一个 claude agent，别开太大以免 OOM）
_CONCURRENCY = int(os.environ.get("KOL_CONCURRENCY", "3"))

# 批次（文件夹）：同名批次累计补传；已识别过的文件按内容指纹跳过，不重复识别。
# 设 KOL_DATA_DIR 指向 Railway 卷可跨重启保留；默认放本地目录（重启会清）。
_DATA_DIR = Path(os.environ.get("KOL_DATA_DIR", str(Path(__file__).resolve().parent.parent / "data")))


def _safe_session(name: str) -> str:
    s = "".join(ch for ch in (name or "") if ch.isalnum() or ch in "-_").strip()
    return s or "default"


def _sess_dir(name: str) -> Path:
    d = _DATA_DIR / "sessions" / _safe_session(name)
    d.mkdir(parents=True, exist_ok=True)
    return d


def _seen_hashes(name: str) -> set[str]:
    f = _sess_dir(name) / "seen.txt"
    return set(f.read_text().split()) if f.exists() else set()


def _mark_seen(name: str, h: str) -> None:
    with (_sess_dir(name) / "seen.txt").open("a") as f:
        f.write(h + "\n")


def _append_model(name: str, kind: str, model) -> None:
    with (_sess_dir(name) / f"{kind}.jsonl").open("a", encoding="utf-8") as f:
        f.write(model.model_dump_json() + "\n")


def _load_models(name: str, kind: str, cls):
    f = _sess_dir(name) / f"{kind}.jsonl"
    out = []
    if f.exists():
        for line in f.read_text(encoding="utf-8").splitlines():
            if line.strip():
                out.append(cls.model_validate_json(line))
    return out

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
def index(s: str = "", _: None = Depends(require_login)) -> str:
    # ?s=批次名 时预填，方便「继续往这个批次补传」
    return _INDEX.read_text(encoding="utf-8").replace("{{SESSION}}", _safe_session(s) if s else "")


def _expand(name: str, data: bytes):
    """把上传项展开成若干 (文件名, PDF字节)。支持直接传 PDF，或传 zip（自动解压里面所有 PDF）。"""
    is_zip = name.lower().endswith(".zip") or data[:2] == b"PK"
    if is_zip:
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            for m in zf.namelist():
                if m.lower().endswith(".pdf") and "__MACOSX" not in m:
                    yield m, zf.read(m)
    else:
        yield name, data


def _as_pdf(data: bytes, name: str) -> Path:
    """extract.py 接收路径；把上传内容落到临时文件再传入（用 uuid 防重名冲突）。"""
    p = Path(tempfile.gettempdir()) / f"_kol_{uuid.uuid4().hex}.pdf"
    p.write_bytes(data)
    return p


def _extract_one(name: str, data: bytes):
    """读一个 PDF，返回 (类型, 结果或错误, 文件名)。"""
    try:
        if _is_approval(data):
            return ("a", extract_approval(_as_pdf(data, name)), name)
        return ("c", extract_contract(_as_pdf(data, name)), name)
    except Exception as e:  # 失败也要显式记下来，绝不静默跳过
        return ("e", str(e), name)


def _run_job(job_id: str, pdfs: list[tuple[str, bytes]], pre_errors: list[str], session: str) -> None:
    """后台线程：只识别该批次里没见过的新文件 → 存入批次 → 对整批配对核对。"""
    errors = list(pre_errors)
    try:
        seen = _seen_hashes(session)
        todo, skipped = [], 0
        for name, data in pdfs:
            h = hashlib.sha256(data).hexdigest()
            if h in seen:
                skipped += 1  # 这批之前传过、已识别，跳过不重复识别
            else:
                todo.append((name, data, h))
        new_ok = 0
        with ThreadPoolExecutor(max_workers=_CONCURRENCY) as ex:
            futmap = {ex.submit(_extract_one, name, data): (name, h) for name, data, h in todo}
            for fut in as_completed(futmap):
                kind, val, _name = fut.result()
                _name2, h = futmap[fut]
                if kind == "e":
                    errors.append(f"{_name2}: 读取失败 {val}")
                else:
                    _append_model(session, "approvals" if kind == "a" else "contracts", val)
                    _mark_seen(session, h)
                    new_ok += 1
                with _JOBS_LOCK:
                    _JOBS[job_id]["done"] += 1
        # 对【整批】（历史 + 本次新增）一起配对核对
        approvals = _load_models(session, "approvals", Approval)
        contracts = _load_models(session, "contracts", Contract)
        store = DedupStore(str(_sess_dir(session) / "dedup.json"))
        items = run_batch(approvals, contracts, store, record=False)
        html = _render_html(items, errors, session, new_ok, skipped, len(approvals), len(contracts))
        with _JOBS_LOCK:
            _JOBS[job_id].update(status="done", html=html)
    except Exception as e:
        with _JOBS_LOCK:
            _JOBS[job_id].update(status="error", html=f"<p>处理出错：{e}</p>")


@app.post("/audit", response_class=HTMLResponse)
async def audit_files(
    files: list[UploadFile], session: str = Form(""), _: None = Depends(require_login)
) -> str:
    # 批次名：留空就开一个新批次（随机短名）；填了同名 = 累计补传
    session = _safe_session(session) if session.strip() else "b" + uuid.uuid4().hex[:6]
    # 先把上传内容读出来 + zip 解开（必须在请求里读完）
    pdfs: list[tuple[str, bytes]] = []
    pre_errors: list[str] = []
    for f in files:
        raw = await f.read()
        try:
            pdfs.extend(_expand(f.filename, raw))
        except Exception as e:
            pre_errors.append(f"{f.filename}: 解压/读取失败 {e}")

    job_id = uuid.uuid4().hex[:12]
    with _JOBS_LOCK:
        _JOBS[job_id] = {"status": "running", "total": len(pdfs), "done": 0, "html": None}
    threading.Thread(target=_run_job, args=(job_id, pdfs, pre_errors, session), daemon=True).start()
    # 立刻返回，跳到进度页（后台慢慢跑，页面自动刷新，绝不卡超时）
    return (
        f"<!doctype html><meta charset=utf-8>"
        f"<meta http-equiv=refresh content='1;url=/job/{job_id}'>"
        f"<body style='font-family:sans-serif;margin:40px'>已收到 {len(pdfs)} 个文件，开始核对…</body>"
    )


@app.get("/job/{job_id}", response_class=HTMLResponse)
def job_page(job_id: str, _: None = Depends(require_login)) -> str:
    with _JOBS_LOCK:
        job = _JOBS.get(job_id)
    if not job:
        return "<meta charset=utf-8><p>任务不存在或已过期，请<a href='/'>重新上传</a>。</p>"
    if job["status"] == "done" or job["status"] == "error":
        return job["html"]
    done, total = job["done"], job["total"]
    return (
        f"<!doctype html><meta charset=utf-8>"
        f"<meta http-equiv=refresh content=3>"  # 每 3 秒自刷新
        f"<body style='font-family:sans-serif;max-width:700px;margin:40px auto'>"
        f"<h2>核对中…</h2>"
        f"<p>已读取 <b>{done} / {total}</b> 个文件，本页每 3 秒自动刷新，读完会自动出总表。</p>"
        f"<p style='color:#888'>（识别每个文件要点时间，文件多请耐心等；别关页面）</p></body>"
    )


def _render_html(items, errors, session="", new_ok=0, skipped=0, total_appr=0, total_con=0) -> str:
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
        if it.match_note:
            detail.insert(0, it.match_note)
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
    sess_html = ""
    if session:
        sess_html = (
            f"<div style='background:#eef4ff;padding:10px 14px;border-radius:8px;margin-bottom:14px'>"
            f"批次：<b>{session}</b>　|　本次新识别 {new_ok} 个，跳过已识别 {skipped} 个　|　"
            f"该批次累计：{total_appr} 审批 + {total_con} 合同<br>"
            f"<a href='/?s={session}'>➕ 继续往「{session}」补传文件（会和现在这些合在一起核对）</a>　"
            f"<a href='/clear/{session}' onclick=\"return confirm('清空批次 {session} 的所有文件？')\">🗑 清空此批次</a>"
            f"</div>"
        )
    return f"""<!doctype html><meta charset=utf-8>
<title>核对结果</title>
<style>body{{font-family:sans-serif;max-width:1100px;margin:24px auto}}
table{{border-collapse:collapse;width:100%}}td,th{{border:1px solid #ddd;padding:8px;font-size:14px}}
th{{background:#fafafa}}</style>
<h2>核对结果：共 {n} 单　✅ {n_pass}　❌ {n_fail}</h2>
{sess_html}
{err_html}
<table><tr><th>单号</th><th>项目/KOL</th><th>结论</th><th>原因 / 需人工项</th></tr>
{''.join(rows)}</table>
<p><a href="/">← 开一个新批次</a></p>"""


@app.get("/clear/{session}", response_class=HTMLResponse)
def clear_session(session: str, _: None = Depends(require_login)) -> str:
    d = _DATA_DIR / "sessions" / _safe_session(session)
    if d.exists():
        shutil.rmtree(d, ignore_errors=True)
    return (
        "<!doctype html><meta charset=utf-8>"
        f"<meta http-equiv=refresh content='1;url=/'>已清空批次「{_safe_session(session)}」，返回首页…"
    )
