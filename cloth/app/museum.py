"""白名单博物馆检索与藏品页抓取。开放接口：大都会、克利夫兰；其他馆通过粘贴藏品页链接抓取。"""
from __future__ import annotations

import html
import re
from urllib.parse import urljoin, urlparse

import httpx

UA = {"User-Agent": "cloth-lab/1.0 (museum research tool)"}


def host_allowed(url: str, whitelist: list[dict]) -> dict | None:
    host = (urlparse(url).hostname or "").lower()
    for w in whitelist:
        if w.get("enabled", True) and (host == w["domain"] or host.endswith("." + w["domain"])):
            return w
    return None


def _met(q: str, limit: int) -> list[dict]:
    base = "https://collectionapi.metmuseum.org/public/collection/v1"
    ids = (httpx.get(f"{base}/search", params={"q": q, "hasImages": "true"}, headers=UA, timeout=20).json().get("objectIDs") or [])[:limit]
    out = []
    for i in ids:
        o = httpx.get(f"{base}/objects/{i}", headers=UA, timeout=20).json()
        if not o.get("primaryImageSmall"):
            continue
        out.append({"title": o.get("title"), "museum": "大都会艺术博物馆", "level": "海外", "dating": o.get("objectDate"),
                    "accession": o.get("accessionNumber"), "url": o.get("objectURL"), "image": o.get("primaryImageSmall"),
                    "license": "开放许可（CC0）" if o.get("isPublicDomain") else "仅研究"})
    return out


def _cleveland(q: str, limit: int) -> list[dict]:
    r = httpx.get("https://openaccess-api.clevelandart.org/api/artworks/", params={"q": q, "has_image": 1, "limit": limit}, headers=UA, timeout=20).json()
    out = []
    for o in r.get("data", []):
        img = ((o.get("images") or {}).get("web") or {}).get("url")
        if img:
            out.append({"title": o.get("title"), "museum": "克利夫兰艺术博物馆", "level": "海外", "dating": o.get("creation_date"),
                        "accession": o.get("accession_number"), "url": o.get("url"), "image": img,
                        "license": "开放许可（CC0）" if o.get("share_license_status") == "CC0" else "仅研究"})
    return out


OPEN_APIS = {"metmuseum.org": _met, "clevelandart.org": _cleveland}


def search(q: str, whitelist: list[dict], limit: int = 6) -> tuple[list[dict], list[str]]:
    """返回 (结果, 说明)。只查询白名单内启用且提供开放接口的馆；其余馆提示用粘贴链接。"""
    results, notes = [], []
    for w in whitelist:
        if not w.get("enabled", True):
            continue
        fn = OPEN_APIS.get(w["domain"])
        if not fn:
            continue
        try:
            results += fn(q, limit)
        except Exception as e:  # 网络或接口异常不影响其他馆
            notes.append(f"{w['name']} 检索失败：{type(e).__name__}")
    web_only = [w["name"] for w in whitelist if w.get("enabled", True) and w["domain"] not in OPEN_APIS]
    if web_only:
        notes.append("以下馆无开放接口，请在藏品页复制链接后用“粘贴链接”入库：" + "、".join(web_only))
    return results, notes


def _meta(page: str, *names) -> str | None:
    for n in names:
        m = re.search(r'<meta[^>]+(?:property|name)=["\']' + re.escape(n) + r'["\'][^>]+content=["\']([^"\']+)', page, re.I) \
            or re.search(r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+(?:property|name)=["\']' + re.escape(n), page, re.I)
        if m:
            return html.unescape(m.group(1)).strip()
    return None


def fetch_page(url: str, w: dict) -> dict:
    r = httpx.get(url, headers=UA, timeout=20, follow_redirects=True)
    r.raise_for_status()
    page = r.text
    title = _meta(page, "og:title", "twitter:title") or (re.search(r"<title>(.*?)</title>", page, re.S | re.I) or [None, url])[1]
    image = _meta(page, "og:image", "twitter:image")
    if not image:
        m = re.search(r'<img[^>]+src=["\']([^"\']+\.(?:jpe?g|png|webp))', page, re.I)
        image = m.group(1) if m else None
    return {"title": html.unescape(title).strip()[:120], "museum": w["name"], "level": w["level"], "url": url,
            "image": urljoin(url, image) if image else None, "license": w.get("license", "仅研究"),
            "dating": _meta(page, "description", "og:description")[:60] if _meta(page, "description", "og:description") else None}


def download(url: str) -> tuple[bytes, str]:
    r = httpx.get(url, headers=UA, timeout=30, follow_redirects=True)
    r.raise_for_status()
    return r.content, r.headers.get("content-type", "image/jpeg").split(";")[0]
