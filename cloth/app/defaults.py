"""默认数据：规格书模板、评审模板、博物馆白名单、模型清单、观察记录模板。"""

LEVELS = {"L1": "L1 实测", "L2": "L2 史料有载", "L3": "L3 同类推定", "L4": "L4 推测", "miss": "缺失", "rule": "规则"}
FIELD_STATUS = {"pending": "待审", "checked": "已校对", "dispute": "有异议", "need": "需补证"}

# 规格书模板：按服饰类别给出默认字段
SPEC_TEMPLATES = {
    "女子服饰 · 命妇礼服": [
        ("F1", "款式", "命妇礼服：大衫 + 霞帔 + 内袍；服装穿在无头、无手臂的白色人台上", "L2"),
        ("F2", "大衫颜色与纹样", "真红，素面无纹", "L2"),
        ("F3", "大衫襟式与袖型", "对襟，前襟细金边；宽大垂袖，袖长过膝；衣长及地", "L2"),
        ("F4", "霞帔位置与形态", "两条带子自颈后经两肩绕到胸前，并排垂于身前正中，下端并合收尖", "L2"),
        ("F5", "霞帔纹样", "金地，云霞翟纹，下段海水江崖", "L3"),
        ("F6", "坠子", "金色水滴形，悬于霞帔末端，宽约霞帔三分之一", "L2"),
        ("F7", "内袍", "金地蟒袍，胸前青绿色大蟒，在领口、两带之间和两侧下摆露出", "L3"),
        ("F8", "领口", "白色交领护领", "L2"),
        ("F9", "腰间白带", "白色长带一条，自前腰垂下", "L3"),
        ("F10", "背面形制", "大衫背部推定为素红；霞帔后段不可见", "L4"),
        ("F11", "衣长、通袖长", "缺失", "miss"),
        ("F12", "禁用元素", "清代马蹄袖、盘扣、清式大襟立领、背心式霞帔、云肩、旗装、唐制齐胸襦裙、日式和服元素、现代拉链纽扣、大衫刺绣", "rule"),
    ],
    "男子服饰 · 赐服": [
        ("F1", "款式", "明代赐服（如飞鱼服、蟒服）；穿在无头白色人台上", "L2"),
        ("F2", "主色", "待考", "miss"),
        ("F3", "领式与襟式", "圆领右衽", "L2"),
        ("F4", "补子或纹样位置", "胸背及通袖、膝襕位置", "L3"),
        ("F5", "纹样题材", "待考", "miss"),
        ("F6", "腰带与配饰", "待考", "miss"),
        ("F12", "禁用元素", "清代马蹄袖、盘扣、清式补服、现代拉链纽扣", "rule"),
    ],
    "通用": [
        ("F1", "款式", "待考", "miss"),
        ("F2", "颜色与纹样", "待考", "miss"),
        ("F3", "领式与襟式", "待考", "miss"),
        ("F12", "禁用元素", "现代拉链纽扣", "rule"),
    ],
}

OBSERVATION_PARTS = {
    "女子服饰 · 命妇礼服": ["冠", "外层大衫", "前胸垂带", "内层袍服", "领口与腰间", "背景物"],
    "男子服饰 · 赐服": ["冠帽", "外袍", "补子或纹样", "腰带", "背景物"],
    "通用": ["整体", "上身", "下身", "配饰"],
}

# 评审模板：维度 code、名称、关联字段、权重、分制、是否必评
REVIEW_TEMPLATE = [
    ("C1", "大衫为真红，不偏橙或粉", "F2", 1, 2),
    ("C2", "大衫素面无纹", "F2", 1, 2),
    ("C3", "对襟，前襟细金边", "F3", 1, 2),
    ("C4", "宽大垂袖，袖长过膝", "F3", 1, 2),
    ("C5", "霞帔居中下垂、两带并合", "F4", 2, 2),
    ("C6", "霞帔云霞翟纹", "F5", 1, 2),
    ("C7", "霞帔下段海水江崖、末端收尖", "F5", 1, 2),
    ("C8", "金色水滴形坠子", "F6", 1, 2),
    ("C9", "内袍金地蟒纹可见", "F7", 1, 2),
    ("C10", "白色交领、腰前白带", "F8 F9", 1, 2),
]

WHITELIST = [
    ("中国国家博物馆", "国家级", "chnmuseum.cn", "网页", "仅研究"),
    ("故宫博物院", "国家级", "dpm.org.cn", "网页", "仅研究"),
    ("孔子博物馆", "省级及重点馆", "kzbwg.cn", "网页", "仅研究"),
    ("山东博物馆", "省级及重点馆", "sdmuseum.com", "网页", "仅研究"),
    ("南京博物院", "省级及重点馆", "njmuseum.com", "网页", "仅研究"),
    ("首都博物馆", "省级及重点馆", "capitalmuseum.org.cn", "网页", "仅研究"),
    ("浙江省博物馆", "省级及重点馆", "zhejiangmuseum.com", "网页", "仅研究"),
    ("大都会艺术博物馆", "海外", "metmuseum.org", "开放接口", "按藏品"),
    ("克利夫兰艺术博物馆", "海外", "clevelandart.org", "开放接口", "按藏品"),
    ("维多利亚与艾伯特博物馆", "海外", "vam.ac.uk", "开放接口", "按藏品"),
    ("大英博物馆", "海外", "britishmuseum.org", "网页", "仅研究"),
    ("台北故宫博物院", "海外", "npm.gov.tw", "网页", "仅研究"),
]

# 模型清单：kind 决定适配器；cross_border 标注数据是否出境
MODELS = [
    {"code": "nb2", "name": "Nano Banana", "purpose": "generate", "kind": "gemini", "endpoint": "https://generativelanguage.googleapis.com", "model": "gemini-2.5-flash-image", "cross_border": True, "concurrency": 4, "timeout": 120},
    {"code": "sd", "name": "Seedream", "purpose": "generate", "kind": "ark", "endpoint": "https://ark.cn-beijing.volces.com/api/v3", "model": "doubao-seedream-4-0-250828", "cross_border": False, "concurrency": 4, "timeout": 120},
    {"code": "gpt", "name": "GPT Image", "purpose": "generate", "kind": "openai", "endpoint": "https://api.openai.com/v1", "model": "gpt-image-1", "cross_border": True, "concurrency": 2, "timeout": 180},
    {"code": "qwen", "name": "Qwen-Image-Edit（本地）", "purpose": "generate", "kind": "comfyui", "endpoint": "http://127.0.0.1:8188", "model": "qwen_image_edit_2509_fp8_e4m3fn.safetensors", "cross_border": False, "concurrency": 1, "timeout": 900},
    {"code": "vision", "name": "视觉读图 / AI 预评", "purpose": "vision", "kind": "openai_chat", "endpoint": "https://dashscope.aliyuncs.com/compatible-mode/v1", "model": "qwen-vl-max", "cross_border": False, "concurrency": 4, "timeout": 90},
    {"code": "fusion", "name": "合拍生成", "purpose": "fusion", "kind": "edit_model", "endpoint": "", "model": "sd", "cross_border": False, "concurrency": 20, "timeout": 30},
]

GROUP_OF_STAGE = {"draft": "E2", "revise": "E3", "apply": "E4", "experiment": "E0"}
STAGE_NAME = {"draft": "生成初稿", "revise": "修订重生成", "apply": "展示应用", "experiment": "实验"}
VIEW_NAME = {"front": "正面", "side": "侧面", "back": "背面"}
LICENSES = ["仅内部研究", "可对外展示", "可商业授权"]
