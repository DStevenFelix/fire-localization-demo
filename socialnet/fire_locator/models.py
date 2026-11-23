# 严格定位契约：Post 只含公开原帖和来源 POI；Extraction 每帖一个参照与方向，不接收真实火源。

from datetime import datetime
from typing import Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field, field_validator

Direction = Literal["东", "东北", "北", "西北", "西", "西南", "南", "东南", "附近"]
SHANGHAI = ZoneInfo("Asia/Shanghai")


# 公开定位输入，时间精确到分钟；位置字段是观察来源而非真实起火点。
class Post(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1)
    timestamp: datetime
    text: str = Field(min_length=1, max_length=4000)
    location_poi_id: str
    urgency: Literal["低", "中", "高"]

    # 无时区按上海时间解释，有时区转为上海时间，禁止秒和微秒。
    @field_validator("timestamp")
    @classmethod
    def minute_timestamp(cls, value: datetime) -> datetime:
        if value.second or value.microsecond:
            raise ValueError("帖子时间戳必须精确到分钟")
        return value.replace(tzinfo=SHANGHAI) if value.tzinfo is None else value.astimezone(SHANGHAI)


# 每条原文只提取一个 reference 和一个八方位/附近，不推断真实罐号。
class Extraction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    post_id: str
    reference: str | None = Field(default=None, description="该条帖子最明确的一个参照物原文，没有则 null")
    direction: Direction = "附近"


# 批量语义结果，一一对应关系由提取器再次检查。
class BatchExtraction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    items: list[Extraction]
