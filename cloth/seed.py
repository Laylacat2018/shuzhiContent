"""导入演示数据：史氏像项目、专家账号、此前各模型的真实生成图。

用法：CLOTH_DATA=/var/lib/cloth-v2 python3 -m cloth.seed --password <专家初始密码>
只在空库上执行；已有项目时直接退出。
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BLOBS = ROOT / "sample"
PORTRAIT = ROOT / "sample" / "shi.jpg"
RUNS = [("E2_nb2_front_1.jpg", "71d87b1557e1f1f94c2ea73bd7508d97.jpg", "Nano Banana"),
        ("E2_gpt_front_1.webp", "40843a08fe959cf59d69b86bb5f491b0.webp", "GPT Image"),
        ("E2_sd_front_1.webp", "3bab5fed0e6018f9c550a6d6c9f6bf4e.webp", "Seedream"),
        ("E2_sd_front_2.webp", "5d3fd6d33bf72139656b22825e215185.webp", "Seedream"),
        ("E2_qwen_front_1.webp", "d8320e090c661e261a560d63d297f681.webp", "Qwen-Image-Edit-2509 · v3"),
        ("E2_qwen_front_2.webp", "c4671c838c6d16bf2cdb113f455fd737.webp", "Qwen-Image-Edit-2509 · v4")]
OBS = {"冠": ("白色珠饰冠体，前额正中红色宝饰；冠顶青绿色扇形饰；两侧垂白色花形珠结", "冠的名称与等级"),
       "外层大衫": ("真红，素面无纹，对襟，前襟细金边，袖极宽大垂过膝", "是否为礼服“大衫”"),
       "前胸垂带": ("金地宽带自颈下垂至足前，满饰五彩云纹与禽鸟纹，下段海水江崖，末端收尖，悬金色水滴形坠子", "翟纹还是蟒纹"),
       "内层袍服": ("领口、胸前与两侧下摆可见金地五彩织纹，胸前可见青色蟒首", "内袍种类"),
       "领口与腰间": ("白色护领；一条白色长带自前腰垂下，右手持白色物", "白带名称与用途"),
       "背景物": ("右侧红金色织物为座椅椅披，不属于服装", "—")}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--password", required=True, help="演示专家账号的初始密码（≥8 位）")
    ap.add_argument("--admin-password", default=os.environ.get("CLOTH_ADMIN_PASSWORD"))
    a = ap.parse_args()
    from fastapi.testclient import TestClient
    from cloth.app.core import store
    from cloth.app.main import app
    with TestClient(app) as admin:
        if store.list("projects"):
            print("已有项目，跳过导入")
            return
        admin_pw = a.admin_password or "cloth2026"
        assert admin.post("/api/login", json={"username": "admin", "password": admin_pw}).status_code == 200, "管理员登录失败，请用 --admin-password"
        ids = {}
        for un, name, role, org in [("wang", "王老师", "lead", "中国国家博物馆"), ("li", "李老师", "expert", "中国国家博物馆"),
                                    ("zhang", "张老师", "expert", "孔子博物馆"), ("chen", "陈运营", "ops", "咪咕")]:
            r = admin.post("/api/users", json={"username": un, "name": name, "role": role, "password": a.password, "org": org})
            ids[un] = r.json()["id"]
        c = {un: TestClient(app) for un in ids}
        for un, cl in c.items():
            cl.post("/api/login", json={"username": un, "password": a.password})
        wang, li = c["wang"], c["li"]
        p = wang.post("/api/projects", json={"name": "明 · 临淮侯夫人史氏命妇礼服", "category": "女子服饰 · 命妇礼服", "dynasty": "明",
                                             "lead_id": ids["wang"], "expert_ids": [ids["li"], ids["zhang"]],
                                             "artifact": "《李言恭配临淮侯夫人史氏像》", "museum": "中国国家博物馆"}).json()
        pid = p["id"]
        src = li.post(f"/api/projects/{pid}/sources/upload", files=[("files", ("李言恭配临淮侯夫人史氏像.jpg", PORTRAIT.read_bytes(), "image/jpeg"))]).json()["added"][0]
        for o in li.get(f"/api/projects/{pid}/observations").json():
            if o["part"] in OBS:
                li.put(f"/api/observations/{o['id']}", json={"part": o["part"], "seen": OBS[o["part"]][0], "question": OBS[o["part"]][1], "rev": o["_rev"]})
        li.post(f"/api/projects/{pid}/literature", json={"title": "《大明会典》冠服 · 命妇冠服", "parts": "前胸垂带",
                                                        "excerpt": "大衫霞帔……深青霞帔，织金云霞翟文"})
        wang.post(f"/api/projects/{pid}/sources/confirm")
        v1 = li.get(f"/api/projects/{pid}/spec").json()["versions"][0]
        for f in v1["fields"]:
            srcs = [src["id"]] if f["level"] in ("L1", "L2", "L3") else []
            cur = li.patch(f"/api/spec-fields/{f['id']}", json={"rev": f["_rev"], "source_ids": srcs}).json()
            li.patch(f"/api/spec-fields/{f['id']}", json={"rev": cur["_rev"], "status": "checked"})
        wang.post(f"/api/spec-versions/{v1['id']}/sign", json={})
        files = [("files", (name, (BLOBS / blob).read_bytes(), "image/webp" if blob.endswith("webp") else "image/jpeg")) for name, blob, _ in RUNS]
        runs = li.post(f"/api/projects/{pid}/runs/upload", files=files, data={"stage": "draft"}).json()
        for r, (_, _, variant) in zip(runs, RUNS):
            store.update("runs", r["id"], {"model_version": variant})
        tpl = wang.get("/api/review-templates").json()[0]
        wang.post(f"/api/projects/{pid}/rounds", json={"run_ids": [r["id"] for r in runs], "expert_ids": [ids["wang"], ids["li"], ids["zhang"]],
                                                     "template_id": tpl["id"], "blind": True})
        print(f"已导入：项目 {p['name']}，{len(runs)} 张候选图，评审已发起。账号 wang / li / zhang / chen，密码为 --password 所设。")


if __name__ == "__main__":
    main()
