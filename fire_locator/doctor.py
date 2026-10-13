"""最小真实 API 检查，日志不打印 key 或向量内容。"""
import json
import os

import httpx

from .config import Settings


def main():
    settings = Settings.load()
    sample_names = [f"这是一段用于验证编码接口的测试文本，编号 {i}" for i in range(10)]
    with httpx.Client(timeout=60) as client:
        for label, method, url, key, body in [
            ("embedding", "POST", settings.embedding_base+"/embeddings", "SILICONFLOW_API_KEY",
             {"model": settings.embedding_model, "input": [{"text": name} for name in sample_names], "encoding_format": "float"}),
            ("deepseek", "GET", settings.deepseek_base+"/models", "DEEPSEEK_API_KEY", None),
        ]:
            try:
                response = client.request(method, url, headers={"Authorization": "Bearer "+os.getenv(key, "")}, json=body)
                info = {"provider": label, "status": response.status_code}
                if response.is_success:
                    data = response.json().get("data", [])
                    info.update({"count": len(data), "dimensions": len(data[0].get("embedding", [])), "indices": [x.get("index") for x in data]} if label == "embedding"
                                else {"models": [x["id"] for x in data]})
                else:
                    # 只保留供应商的错误 message，清理任何意外 key 回显。
                    message = response.json().get("message") or response.json().get("error", {}).get("message")
                    info["message"] = str(message).replace(os.getenv(key, "_missing_"), "[redacted]")[:300]
                print(json.dumps(info, ensure_ascii=False), flush=True)
            except (httpx.HTTPError, ValueError) as error:
                print(json.dumps({"provider": label, "error_type": type(error).__name__}), flush=True)


if __name__ == "__main__":
    main()
