from datetime import datetime
from typing import Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field, field_validator

Direction = Literal["东", "东北", "北", "西北", "西", "西南", "南", "东南", "附近"]
SHANGHAI = ZoneInfo("Asia/Shanghai")


class Post(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1)
    timestamp: datetime
    text: str = Field(min_length=1, max_length=4000)
    location_poi_id: str
    urgency: Literal["低", "中", "高"]

    @field_validator("timestamp")
    @classmethod
    def minute_timestamp(cls, value: datetime) -> datetime:
        if value.second or value.microsecond:
            raise ValueError("帖子时间戳必须精确到分钟")
        return value.replace(tzinfo=SHANGHAI) if value.tzinfo is None else value.astimezone(SHANGHAI)


class Extraction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    post_id: str
    reference: str | None = Field(default=None, description="该条帖子最明确的一个参照物原文，没有则 null")
    direction: Direction = "附近"


class BatchExtraction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    items: list[Extraction]
