# 新版定位参数：半径 15、总张角 45°、匹配阈值 0.7、每候选 30 分钟证据窗。宿主注入自身在线模型配置。

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent


# 通用算法默认参数；宿主采用相同几何/计票规则，仅注入模型服务配置。
@dataclass(frozen=True)
class Settings:
    root: Path = ROOT
    batch_size: int = 10
    radius_m: float = 15.0
    sector_degrees: float = 45.0
    match_threshold: float = 0.7
    cold_minutes: int = 30
    embedding_model: str = "Qwen/Qwen3-VL-Embedding-8B"
    embedding_base: str = "https://api.siliconflow.cn/v1"
    deepseek_model: str = "deepseek-flash"
    deepseek_base: str = "https://api.deepseek.com"

    @classmethod
    def load(cls):
        load_dotenv(ROOT / ".env")
        size = int(os.getenv("BATCH_SIZE", "10"))
        if size <= 0:
            raise ValueError("BATCH_SIZE 必须大于 0")
        return cls(batch_size=size, embedding_model=os.getenv("EMBEDDING_MODEL", cls.embedding_model),
                   embedding_base=os.getenv("SILICONFLOW_BASE_URL", cls.embedding_base),
                   deepseek_model=os.getenv("DEEPSEEK_MODEL", cls.deepseek_model),
                   deepseek_base=os.getenv("DEEPSEEK_BASE_URL", cls.deepseek_base))
