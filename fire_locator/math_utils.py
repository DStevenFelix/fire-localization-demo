import numpy as np


def cosine_similarity(left, right):
    """矩阵形式的余弦相似度，零向量定义为 0。"""
    a, b = np.asarray(left, dtype=float), np.asarray(right, dtype=float)
    if a.size == 0 or b.size == 0:
        return np.empty((len(left), len(right)))
    if a.ndim != 2 or b.ndim != 2 or a.shape[1] != b.shape[1]:
        raise ValueError("余弦相似度输入维度不一致")
    denominator = np.linalg.norm(a, axis=1)[:, None]*np.linalg.norm(b, axis=1)[None, :]
    return np.clip(np.divide(a@b.T, denominator, out=np.zeros((len(a), len(b))), where=denominator != 0), -1, 1)
