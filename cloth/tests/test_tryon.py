"""换装核心逻辑：规格书提示词、质检解析、主备切换与降级、火山签名。不调用真实模型。"""
import io

import pytest
from PIL import Image

from cloth.app import ai, defaults, tryon

FIELDS = [{"code": c, "name": n, "content": t, "level": l} for c, n, t, l in defaults.SPEC_TEMPLATES["女子服饰 · 命妇礼服"]]


def img(color=(200, 30, 30), size=(300, 400)):
    b = io.BytesIO()
    Image.new("RGB", size, color).save(b, "PNG")
    return b.getvalue()


def test_prompt_from_spec():
    p, neg = tryon.build("tryon", FIELDS)
    assert "图1是观众本人的照片" in p and "下端并合收尖" in p and "金色水滴形" in p
    assert "人台" not in p and "缺失" not in p          # 去掉人台描述与缺失字段
    assert "马蹄袖" in p and "马蹄袖" in neg             # 禁用元素进入提示词与反向提示词
    s, _ = tryon.build("swap", FIELDS)
    assert "图1是合拍模板" in s and "形制要点" not in s   # 模板合影只换脸，不重述服饰
    q, _ = tryon.build("portrait", FIELDS, "书房")
    assert "场景：书房" in q
    with pytest.raises(ValueError):
        tryon.build("x", FIELDS)


def test_refs_and_size():
    s, g, t = img(size=(400, 800)), img(), img(size=(600, 800))
    assert tryon.refs_for("tryon", s, g, None) == [s, g]
    assert tryon.refs_for("swap", s, None, t) == [t, s]
    assert tryon.refs_for("portrait", s, g, None) == [g, s]
    w, h = map(int, tryon.size_for("tryon", s, None).split("x"))
    assert w % 64 == 0 and h % 64 == 0 and abs(w / h - 0.5) < 0.05


def test_qc_parse():
    good = '{"faces":1,"checks":[{"id":"G1","ok":true},{"id":"G2","ok":true}],"score":95}'
    assert tryon.qc_parse(good, 70)["ok"]
    bad = '```json\n{"faces":1,"checks":[{"id":"G1","ok":true},{"id":"G6","ok":false,"why":"两枚坠子"},{"id":"G7","ok":false}],"score":90}\n```'
    r = tryon.qc_parse(bad, 70)
    assert not r["ok"] and r["score"] == 33 and "G6：两枚坠子" in r["failed"]   # 模型自评分不能高于逐项结果
    assert not tryon.qc_parse('{"faces":2,"checks":[{"id":"G1","ok":true}],"score":100}', 70)["ok"]
    assert not tryon.qc_parse('{"faces":1,"checks":[{"id":"G1","ok":true},{"id":"G2","ok":true},{"id":"G3","ok":true},{"id":"IMAGE","ok":false}]}', 70)["ok"]
    assert not tryon.qc_parse("不是 JSON", 70)["ok"]


class Fake(ai.Adapter):
    def __init__(self, code, outcomes):
        super().__init__({"name": code, "code": code}, "k")
        self.outcomes, self.calls = list(outcomes), 0

    def generate(self, prompt, negative, refs, seed, size=None):
        self.calls += 1
        o = self.outcomes.pop(0)
        if isinstance(o, Exception):
            raise o
        return o


class FakeQC:
    def __init__(self, answers):
        self.answers = list(answers)

    def ask(self, prompt, images, json_mode=False):
        return self.answers.pop(0)


def qc(score, faces=1):
    n_bad = 0 if score >= 100 else 1
    return '{"faces":%d,"checks":[{"id":"G1","ok":true}%s],"score":%d}' % (faces, ',{"id":"G2","ok":false}' if n_bad else "", score)


def runner(models):
    return lambda code: (models[code], {"name": code, "code": code}, False)


def test_failover_on_error():
    a, b = Fake("a", [ai.ModelError("限流")]), Fake("b", [b"IMG-B"])
    out, info = tryon.run("tryon", img(), img(), None, FIELDS, {"tryon_chain": ["a", "b"], "qc": False}, runner({"a": a, "b": b}))
    assert out == b"IMG-B" and info["model"] == "b" and info["attempts"][0]["error"] == "限流"


def test_qc_retry_then_pass():
    a = Fake("a", [b"BAD", b"GOOD"])
    out, info = tryon.run("tryon", img(), img(), None, FIELDS, {"tryon_chain": ["a"]}, runner({"a": a}), FakeQC([qc(40), qc(100)]))
    assert out == b"GOOD" and info["qc_score"] == 100 and len(info["attempts"]) == 2 and not info["degraded"]


def test_degraded_and_floor():
    a = Fake("a", [b"A1", b"A2"])
    b = Fake("b", [b"B1", b"B2"])
    # 都不合格：返回分数最高且达到兜底分的一张（50 分的 B1）
    out, info = tryon.run("tryon", img(), img(), None, FIELDS, {"tryon_chain": ["a", "b"], "qc_floor": 45},
                          runner({"a": a, "b": b}), FakeQC(['{"faces":1,"checks":[{"id":"G1","ok":false}],"score":0}', qc(0), qc(50), qc(0)]))
    assert out == b"B1" and info["degraded"]
    # 兜底分以下：报失败，不把明显走样的图给观众
    c = Fake("c", [b"C1", b"C2"])
    with pytest.raises(ai.ModelError):
        tryon.run("tryon", img(), img(), None, FIELDS, {"tryon_chain": ["c"], "qc_floor": 60}, runner({"c": c}), FakeQC([qc(50), qc(50)]))


def test_qc_service_error_does_not_block():
    class Boom:
        def ask(self, *a, **k):
            raise ai.ModelError("质检超时")
    out, info = tryon.run("swap", img(), None, img(), FIELDS, {"swap_chain": ["a"]}, runner({"a": Fake("a", [b"X"])}), Boom())
    assert out == b"X" and info["qc_score"] is None


def test_missing_inputs_and_chain():
    with pytest.raises(ai.ModelError):
        tryon.run("tryon", img(), None, None, FIELDS, {"tryon_chain": ["a"]}, runner({"a": Fake("a", [b"X"])}))
    with pytest.raises(ai.ModelError):
        tryon.run("tryon", img(), img(), None, FIELDS, {"tryon_chain": []}, runner({}))


def test_volc_sign_shape():
    h = ai.volc_sign("AK", "SK", "POST", "visual.volcengineapi.com", "/", {"Version": "2022-08-31", "Action": "X"}, b"{}", now=1700000000)
    h2 = ai.volc_sign("AK", "SK", "POST", "visual.volcengineapi.com", "/", {"Action": "X", "Version": "2022-08-31"}, b"{}", now=1700000000)
    assert h == h2                                           # 查询参数顺序无关
    assert h["Authorization"].startswith("HMAC-SHA256 Credential=AK/20231114/cn-north-1/cv/request, SignedHeaders=content-type;host;x-content-sha256;x-date, Signature=")
    assert h["X-Content-Sha256"] == "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"
