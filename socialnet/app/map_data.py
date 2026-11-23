# 旧地图读取工具：直接解析 XLSX 内部 XML，并读取旧场景几何 JSON；当前运行入口不调用。
# 此处仍指向 map/地图数据.xlsx 和 map/scene_geometry.json，现有旧文件位于 map_old/，不可视为可用的新地图入口。

from __future__ import annotations

import json
import posixpath
from functools import lru_cache
from pathlib import Path
from xml.etree import ElementTree as ET
from zipfile import ZipFile


MAP_DIR = Path(__file__).resolve().parent.parent / "map"
NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
REL_ID = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"


# 无需 Excel 库解析共享字符串、工作表关系和单元格；首行作表头并验证必要表单，当前未接入。
@lru_cache(maxsize=1)
def load_map_workbook() -> dict[str, list[dict[str, str]]]:
    """Read the project workbook without a spreadsheet runtime dependency."""
    result: dict[str, list[dict[str, str]]] = {}
    with ZipFile(MAP_DIR / "地图数据.xlsx") as archive:
        shared: list[str] = []
        if "xl/sharedStrings.xml" in archive.namelist():
            shared = [
                "".join(node.text or "" for node in item.findall(".//m:t", NS))
                for item in ET.fromstring(archive.read("xl/sharedStrings.xml")).findall("m:si", NS)
            ]
        relationships = {
            item.attrib["Id"]: item.attrib["Target"]
            for item in ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        }
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        for sheet in workbook.findall("m:sheets/m:sheet", NS):
            target = relationships[sheet.attrib[REL_ID]]
            target = target.lstrip("/") if target.startswith("/") else posixpath.normpath("xl/" + target)
            document = ET.fromstring(archive.read(target))
            rows: list[dict[str, str]] = []
            headers: dict[str, str] = {}
            for row in document.findall("m:sheetData/m:row", NS):
                values: dict[str, str] = {}
                for cell in row.findall("m:c", NS):
                    column = "".join(c for c in cell.attrib["r"] if c.isalpha())
                    value = cell.find("m:v", NS)
                    text = value.text or "" if value is not None else ""
                    if cell.attrib.get("t") == "s":
                        text = shared[int(text)]
                    elif cell.attrib.get("t") == "inlineStr":
                        text = "".join(node.text or "" for node in cell.findall(".//m:t", NS))
                    values[column] = text
                if not headers:
                    headers = values
                elif any(values.values()):
                    rows.append({header: values.get(column, "") for column, header in headers.items() if header})
            result[sheet.attrib["name"]] = rows
    for required in ("POIs", "Areas", "Roads", "Intersections", "QueryRules"):
        if required not in result:
            raise ValueError(f"Map workbook is missing sheet: {required}")
    return result


# 缓存读取旧版几何 JSON；当前文件布局下旧路径可能不存在，不作为规范地图来源。
@lru_cache(maxsize=1)
def load_scene_geometry() -> dict:
    return json.loads((MAP_DIR / "scene_geometry.json").read_text(encoding="utf-8"))
