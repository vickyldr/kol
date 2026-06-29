"""启动入口：自己从环境变量读 PORT（不依赖 shell 展开 $PORT），最稳。

Railway/容器里直接 `python web/run.py` 即可。
"""

import os
import sys
from pathlib import Path

# 让 `web` 和 `kol_audit` 都能 import 到
_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))
sys.path.insert(0, str(_ROOT / "src"))

import uvicorn

from web.server import app

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run(app, host="0.0.0.0", port=port)
