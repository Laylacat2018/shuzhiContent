"""按 PRD v2.0 各页验收点编写的端到端测试（演示模式：模型为模拟输出）。"""
import io
import json
import os
import time

import pytest
from PIL import Image


@pytest.fixture(scope="module")
def env(tmp_path_factory):
    os.environ["CLOTH_DATA"] = str(tmp_path_factory.mktemp("data"))
    os.environ["CLOTH_DEMO"] = "1"
    from fastapi.testclient import TestClient
    from cloth.app.main import app
    with TestClient(app) as admin:
        admin.post("/api/login", json={"username": "admin", "password": "cloth2026"})
        ids = {}
        for un, name, role in [("wang", "王老师", "lead"), ("li", "李老师", "expert"), ("zhang", "张老师", "expert"),
                               ("zhao", "赵老师", "expert"), ("ops", "运营小陈", "ops")]:
            ids[un] = admin.post("/api/users", json={"username": un, "name": name, "role": role, "password": "pass12345"}).json()["id"]
        clients = {"admin": admin}
        for un in ids:
            c = TestClient(app)
            assert c.post("/api/login", json={"username": un, "password": "pass12345"}).status_code == 200
            clients[un] = c
        yield clients, ids


def png(color=(200, 30, 30), size=(300, 400)):
    b = io.BytesIO()
    Image.new("RGB", size, color).save(b, "PNG")
    return b.getvalue()


def wait_jobs(c, pid, timeout=30):
    t0 = time.time()
    while time.time() - t0 < timeout:
        jobs = c.get(f"/api/projects/{pid}/jobs").json()
        if all(t["status"] in ("done", "failed") for j in jobs for t in j["tasks"]):
            return jobs
        time.sleep(0.3)
    raise AssertionError("生成超时")


def test_full_workflow(env):
    cl, ids = env
    wang, li, zhang, zhao, ops, admin = cl["wang"], cl["li"], cl["zhang"], cl["zhao"], cl["ops"], cl["admin"]

    # ---------------- P01
    assert wang.post("/api/projects", json={"name": "", "category": "女子服饰 · 命妇礼服", "lead_id": ids["wang"]}).status_code == 400
    assert li.post("/api/projects", json={"name": "x", "category": "通用", "lead_id": ids["wang"]}).status_code == 403
    p = wang.post("/api/projects", json={"name": "明 · 临淮侯夫人史氏命妇礼服", "category": "女子服饰 · 命妇礼服", "lead_id": ids["wang"],
                                         "expert_ids": [ids["li"], ids["zhang"]], "museum": "中国国家博物馆"}).json()
    pid = p["id"]
    assert zhao.get(f"/api/projects/{pid}").status_code == 403          # 未邀请专家无权限
    assert pid not in [x["id"] for x in zhao.get("/api/projects").json()]
    assert pid in [x["id"] for x in li.get("/api/projects").json()]

    # ---------------- P02
    files = [("files", (f"s{i}.png", png((200, 30 + i, 30)), "image/png")) for i in range(5)]
    r = li.post(f"/api/projects/{pid}/sources/upload", files=files).json()
    assert len(r["added"]) == 5 and all(s["sha256"] for s in r["added"])
    assert sum(1 for s in r["added"] if s["primary"]) == 1
    r = li.post(f"/api/projects/{pid}/sources/upload", files=[("files", ("a.pdf", b"%PDF", "application/pdf")),
                                                               ("files", ("big.png", b"0" * (51 * 1024 * 1024), "image/png"))]).json()
    assert len(r["added"]) == 0 and len(r["errors"]) == 2
    assert li.post(f"/api/projects/{pid}/sources/link", json={"url": "https://example.com/x"}).status_code == 400
    srcs = li.get(f"/api/projects/{pid}/sources").json()
    second = srcs[1]
    li.patch(f"/api/sources/{second['id']}", json={"primary": True})
    srcs = li.get(f"/api/projects/{pid}/sources").json()
    assert [s["id"] for s in srcs if s["primary"]] == [second["id"]]
    assert li.post(f"/api/projects/{pid}/sources/confirm").status_code == 403
    assert wang.post(f"/api/projects/{pid}/sources/confirm").status_code == 200
    obs = li.get(f"/api/projects/{pid}/observations").json()
    o = obs[1]
    n = li.put(f"/api/observations/{o['id']}", json={"part": o["part"], "seen": "真红素面", "question": "", "rev": o["_rev"]}).json()
    assert n["status"] == "confirmed" and n["editor"] == "李老师"
    assert zhang.put(f"/api/observations/{o['id']}", json={"part": o["part"], "seen": "x", "rev": o["_rev"]}).status_code == 409
    assert li.post(f"/api/projects/{pid}/observations/ai-read").status_code == 503   # 视觉模型未配置密钥：明确报错

    # ---------------- P03
    spec = li.get(f"/api/projects/{pid}/spec").json()
    v1 = spec["versions"][0]
    f5 = next(f for f in v1["fields"] if f["code"] == "F5")
    assert li.patch(f"/api/spec-fields/{f5['id']}", json={"rev": f5["_rev"], "level": "L2", "source_ids": []}).status_code == 400
    up = li.patch(f"/api/spec-fields/{f5['id']}", json={"rev": f5["_rev"], "content": "金地，云霞翟纹", "source_ids": [second["id"]]}).json()
    assert up["status"] == "pending"
    assert zhang.patch(f"/api/spec-fields/{f5['id']}", json={"rev": f5["_rev"], "content": "冲突"}).status_code == 409
    log = admin.get("/api/settings/audit", params={"project": pid}).json()
    assert any(x["action"] == "编辑规格书字段" and x["before"]["content"] != x["after"]["content"] for x in log)
    c = zhang.post(f"/api/spec-versions/{v1['id']}/comments", json={"field_code": "F4", "body": "两带是否并排？@李老师 请确认"}).json()
    assert ids["li"] in c["mentions"]
    assert any("@" in t["text"] for t in li.get("/api/todos").json())
    # 全部校对，但有未解决批注 → 不能签署
    for f in li.get(f"/api/projects/{pid}/spec").json()["versions"][0]["fields"]:
        srcs_ = f["source_ids"] or ([second["id"]] if f["level"] in ("L1", "L2", "L3") else [])
        cur = li.patch(f"/api/spec-fields/{f['id']}", json={"rev": f["_rev"], "source_ids": srcs_}).json()
        li.patch(f"/api/spec-fields/{f['id']}", json={"rev": cur["_rev"], "status": "checked"})
    r = wang.post(f"/api/spec-versions/{v1['id']}/sign", json={})
    assert r.status_code == 400 and "批注" in r.json()["message"]
    wang.post(f"/api/comments/{c['id']}/resolve")
    f4 = next(f for f in li.get(f"/api/projects/{pid}/spec").json()["versions"][0]["fields"] if f["code"] == "F4")
    li.patch(f"/api/spec-fields/{f4['id']}", json={"rev": f4["_rev"], "status": "checked"})
    assert li.post(f"/api/projects/{pid}/jobs", json={}).status_code == 400            # 未签署不能生成
    assert wang.post(f"/api/spec-versions/{v1['id']}/sign", json={}).json()["status"] == "signed"
    f1 = li.get(f"/api/projects/{pid}/spec").json()["versions"][0]["fields"][0]
    assert li.patch(f"/api/spec-fields/{f1['id']}", json={"rev": f1["_rev"], "content": "x"}).status_code == 400  # 已锁定
    assert "人台" in li.get(f"/api/spec-versions/{v1['id']}/prompt").json()["prompt"]

    # ---------------- P04
    assert li.post(f"/api/projects/{pid}/jobs", json={"group": "E0"}).status_code == 403   # 实验模式仅技术
    admin.patch(f"/api/settings/models/{next(m['id'] for m in admin.get('/api/settings/models').json() if m['code'] == 'gpt')}", json={"enabled": False})
    job = li.post(f"/api/projects/{pid}/jobs", json={"stage": "draft", "per_model": 2}).json()
    jobs = wait_jobs(li, pid)
    tasks = {t["model"]: t for t in jobs[0]["tasks"]}
    assert tasks["gpt"]["status"] == "failed" and "停用" in tasks["gpt"]["error"]
    assert all(tasks[m]["status"] == "done" for m in ("nb2", "sd", "qwen"))
    runs = li.get(f"/api/projects/{pid}/runs").json()
    assert len(runs) == 6 and all(r_["spec_version"] == 1 and r_["seed"] and r_["mock"] for r_ in runs)
    assert "prompt" not in runs[0]                                       # 专家看不到提示词
    img = Image.open(io.BytesIO(li.get(f"/api/files/{runs[0]['file_id']}").content))
    assert "AIGC" in img.info
    up = li.post(f"/api/projects/{pid}/runs/upload", files=[("files", ("E2_qwen_front_1.png", png(), "image/png"))]).json()
    assert up[0]["group"] == "E2" and up[0]["model"] == "qwen" and up[0]["view"] == "front"

    # ---------------- P05
    tpl = next(t for t in wang.get("/api/review-templates").json() if t["name"] == "命妇礼服")
    dims = tpl["dims"] + [{"code": "C11", "name": "织造工艺合理性", "fields": "", "weight": 2, "scale": 5, "required": True}]
    tpl2 = wang.post("/api/review-templates", json={"name": "命妇礼服", "category": tpl["category"], "dims": dims}).json()
    assert tpl2["version"] == 2
    cand = [r_["id"] for r_ in runs[:3]]
    rd = wang.post(f"/api/projects/{pid}/rounds", json={"run_ids": cand, "expert_ids": [ids["wang"], ids["li"], ids["zhang"]],
                                                       "template_id": tpl2["id"], "blind": True}).json()
    sheet = li.get(f"/api/rounds/{rd['id']}/sheet/{cand[0]}").json()
    assert "model" not in sheet["run"] and sheet["run"]["label"] == "候选 A"     # 盲评隐藏模型
    full = {d["code"]: d["scale"] for d in dims}
    bad = {"scores": {"C1": 2}, "verdict": "通过", "submit": True}
    assert li.put(f"/api/rounds/{rd['id']}/reviews/{cand[0]}", json=bad).status_code == 400   # 必评项未打完
    plans = {"wang": (full, "通过"), "li": ({**full, "C5": 0}, "退回改规格书"), "zhang": ({**full, "C11": 3}, "通过")}
    for who, (scores, verdict) in plans.items():
        for rid_ in cand:
            body = {"scores": scores, "verdict": verdict, "submit": True,
                    "suggestions": [{"field": "F4", "change": "两带并排垂于身前正中，不得做成背心", "reason": "背心"}] if who == "li" and rid_ == cand[0] else []}
            if who == "li" and rid_ == cand[0]:
                body["annotations"] = [{"x": 50, "y": 16, "label": "背心式", "severity": "error"}]
                body["forbidden"] = ["背心式霞帔"]
            assert cl[who].put(f"/api/rounds/{rd['id']}/reviews/{rid_}", json=body).status_code == 200
        if who == "wang":
            assert "others" not in cl["wang"].get(f"/api/rounds/{rd['id']}/sheet/{cand[0]}").json()   # 未全部提交看不到他人
    s = li.get(f"/api/rounds/{rd['id']}/sheet/{cand[0]}").json()
    assert len(s["others"]) == 3 and s["mine"]["annotations"][0]["label"] == "背心式"
    c5 = next(d for d in s["summary"]["dims"] if d["code"] == "C5")
    assert c5["divergent"] and c5["mean"] == round((2 + 0 + 2) / 3, 2)
    # 加权分手算：每项满分，除 C11 有 5、5、3
    den = sum(d["weight"] * d["scale"] for d in dims)
    c11 = (5 + 5 + 3) / 3
    num_c5 = (2 + 0 + 2) / 3
    num = sum(d["weight"] * d["scale"] for d in dims if d["code"] not in ("C5", "C11")) + 2 * num_c5 + 2 * c11
    means = {d_["code"]: d_["mean"] for d_ in s["summary"]["dims"]}
    expect = round(sum(d_["weight"] * means[d_["code"]] for d_ in dims) / den * 100, 1)
    assert s["summary"]["forbidden"] == [] and s["summary"]["score"] == expect     # 仅 1/3 专家标禁用元素，不扣分
    assert 0 < expect < 100 and abs(expect - num / den * 100) < 0.2

    # ---------------- P06
    cmp_ = li.get(f"/api/projects/{pid}/compare").json()
    assert len(cmp_["recommendations"]) == 3 and "通过" in cmp_["recommendations"][0]["reason"]
    assert up[0]["id"] not in cmp_["scored"]                             # 未评审的图不参与推荐
    top = cmp_["recommendations"][0]["run"]["id"]
    other = next(x for x in cand if x != top)
    zhang.put(f"/api/projects/{pid}/vote", json={"first": other, "reason": "内袍更像明代实物"})
    zhang.put(f"/api/projects/{pid}/vote", json={"first": top, "reason": "改选"})
    assert li.get(f"/api/projects/{pid}/compare").json()["tally"] == {top: 1}
    assert wang.post(f"/api/projects/{pid}/decision", json={"run_id": other}).status_code == 400
    d = wang.post(f"/api/projects/{pid}/decision", json={"run_id": other, "reason": "采纳张老师意见"}).json()
    assert d["differs"]

    # ---------------- P07
    groups = wang.get(f"/api/projects/{pid}/revisions").json()
    f4g = next(g for g in groups if g["field"] == "F4")
    assert len(f4g["items"]) == 1
    x = f4g["items"][0]
    assert wang.post(f"/api/revisions/{x['id']}", json={"action": "reject"}).status_code == 400
    wang.post(f"/api/revisions/{x['id']}", json={"action": "accept"})
    vs = wang.get(f"/api/projects/{pid}/spec").json()["versions"]
    assert [v["no"] for v in vs] == [1, 2] and vs[0]["status"] == "signed"
    v2 = vs[1]
    f4v2 = next(f for f in v2["fields"] if f["code"] == "F4")
    assert f4v2["status"] == "pending" and "背心" in f4v2["content"]
    assert next(f for f in vs[0]["fields"] if f["code"] == "F4")["content"] != f4v2["content"]
    assert li.post(f"/api/projects/{pid}/jobs", json={"stage": "revise"}).status_code == 400   # V2 未签署
    diff = wang.get(f"/api/projects/{pid}/spec/diff", params={"a": vs[0]["id"], "b": v2["id"]}).json()
    assert [d_["code"] for d_ in diff] == ["F4"]
    li.patch(f"/api/spec-fields/{f4v2['id']}", json={"rev": f4v2["_rev"], "status": "checked"})
    assert wang.post(f"/api/spec-versions/{v2['id']}/sign", json={"cosigner_id": ids["li"]}).json()["status"] == "signing"
    assert li.post(f"/api/spec-versions/{v2['id']}/cosign").json()["status"] == "signed"
    li.post(f"/api/projects/{pid}/jobs", json={"stage": "revise", "models": ["nb2"], "per_model": 1})
    wait_jobs(li, pid)
    rev_run = [r_ for r_ in li.get(f"/api/projects/{pid}/runs").json() if r_["stage"] == "revise"][0]
    assert rev_run["spec_version"] == 2 and rev_run["ref_file_id"] == next(r_ for r_ in runs if r_["id"] == other)["file_id"]

    # ---------------- P08
    fin = wang.post(f"/api/projects/{pid}/finals", json={"run_ids": [other], "license": "可对外展示", "cosigner_ids": [ids["li"]]}).json()
    assert fin["status"] == "cosigning" and fin["algo"] in ("SM3", "SHA-256")
    assert ops.get("/api/finals-shareable").json() == []                 # 会签未完成不能做模板
    li.post(f"/api/finals/{fin['id']}/cosign")
    assert wang.post(f"/api/finals/{fin['id']}/verify").json()["ok"]
    rv = [x for x in __import__("cloth.app.core", fromlist=["store"]).store.list("reviews") if x["submitted"]][0]
    from cloth.app.core import store
    store.update("reviews", rv["id"], {"opinion": "篡改"})
    assert not wang.post(f"/api/finals/{fin['id']}/verify").json()["ok"]
    store.update("reviews", rv["id"], {"opinion": rv.get("opinion", "")})
    assert wang.post(f"/api/finals/{fin['id']}/verify").json()["ok"]
    rep = wang.get(f"/api/finals/{fin['id']}/report").text
    assert fin["hash"] in rep and "采纳张老师意见" in rep

    # ---------------- P09
    sh = ops.get("/api/finals-shareable").json()
    assert [x["id"] for x in sh] == [fin["id"]]
    ts = ops.post("/api/templates", json={"final_id": fin["id"], "count": 2}).json()
    t0 = time.time()
    while any(t["status"] == "generating" for t in ops.get("/api/templates").json()) and time.time() - t0 < 20:
        time.sleep(0.3)
    ts = ops.get("/api/templates").json()
    assert all(t["status"] == "pending" for t in ts)
    assert ops.post("/api/activities", json={"name": "岐阳世泽展厅", "start": "2020-01-01", "end": "2099-01-01",
                                             "template_ids": [ts[0]["id"]], "daily_limit": 3}).status_code == 400
    assert wang.post(f"/api/templates/{ts[1]['id']}/review", json={"ok": False}).status_code == 400
    wang.post(f"/api/templates/{ts[1]['id']}/review", json={"ok": False, "reason": "坠子缺失"})
    wang.post(f"/api/templates/{ts[0]['id']}/review", json={"ok": True})
    act = ops.post("/api/activities", json={"name": "岐阳世泽展厅", "start": "2020-01-01", "end": "2099-01-01",
                                            "template_ids": [ts[0]["id"]], "daily_limit": 3}).json()
    assert ops.get(f"/api/activities/{act['id']}/qr.svg").headers["content-type"].startswith("image/svg")

    # ---------------- P10（无需登录）
    from fastapi.testclient import TestClient
    from cloth.app.main import app
    vis = TestClient(app)
    tok = act["token"]
    info = vis.get(f"/api/m/{tok}").json()
    assert info["templates"][0]["id"] == ts[0]["id"]
    nfiles = len(store.list("files"))
    assert vis.post(f"/api/m/{tok}/photo", data={"template_id": ts[0]["id"]}, files={"photo": ("me.jpg", png(), "image/jpeg")}).status_code == 400
    assert vis.post(f"/api/m/{tok}/photo", data={"template_id": ts[0]["id"], "consent": "true", "minor": "true"},
                    files={"photo": ("me.jpg", png(), "image/jpeg")}).status_code == 400
    res = vis.post(f"/api/m/{tok}/photo", data={"template_id": ts[0]["id"], "consent": "true"}, files={"photo": ("me.jpg", png(), "image/jpeg")}).json()
    assert len(store.list("files")) == nfiles + 1                         # 只多了结果图，自拍未落盘
    out = vis.get(f"/api/m/result/{res['id']}", params={"key": res["key"]})
    meta = json.loads(Image.open(io.BytesIO(out.content)).info["AIGC"])
    assert meta["label"] == "AI 生成" and meta["activity"] == "岐阳世泽展厅"
    assert vis.get(f"/api/m/result/{res['id']}", params={"key": "wrong"}).status_code == 404
    for _ in range(2):
        vis.post(f"/api/m/{tok}/photo", data={"template_id": ts[0]["id"], "consent": "true"}, files={"photo": ("me.jpg", png(), "image/jpeg")})
    assert vis.post(f"/api/m/{tok}/photo", data={"template_id": ts[0]["id"], "consent": "true"},
                    files={"photo": ("me.jpg", png(), "image/jpeg")}).status_code == 429   # 每日上限 3
    store.update("photo_jobs", res["id"], {"expires": time.time() - 1})
    assert vis.get(f"/api/m/result/{res['id']}", params={"key": res["key"]}).status_code == 410
    # 撤销定稿 → 模板下线 → 手机端不可见
    wang.post(f"/api/finals/{fin['id']}/revoke", json={"reason": "复核发现问题"})
    assert vis.get(f"/api/m/{tok}").json()["templates"] == []

    # ---------------- P11
    ms = admin.get("/api/settings/models").json()
    nb = next(m for m in ms if m["code"] == "nb2")
    r = admin.patch(f"/api/settings/models/{nb['id']}", json={"key": "AIzaSyTESTKEY1234"}).json()
    assert r["key_tail"] == "••••1234" and "key" not in r
    assert "AIzaSy" not in json.dumps(admin.get("/api/settings/models").json())
    assert li.get("/api/settings/models").status_code == 403
    admin.patch(f"/api/users/{ids['zhao']}", json={"active": False})
    assert zhao.get("/api/me").status_code == 401
    wl = next(w for w in admin.get("/api/settings/whitelist").json() if w["domain"] == "metmuseum.org")
    admin.patch(f"/api/settings/whitelist/{wl['id']}", json=dict({k: wl[k] for k in ("name", "level", "domain", "method", "license")}, enabled=False))
    assert li.post(f"/api/projects/{pid}/sources/link", json={"url": "https://www.metmuseum.org/art/collection/search/1"}).status_code == 400
