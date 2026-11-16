"""Local readiness checks. File existence never counts as a successful AI acceptance run."""
import json
import os
from pathlib import Path
import shutil
import urllib.request

from ops.production.model_plan import PUBLIC,GATED,QWEN_FILES


def repository(cache, repo, required=None):
    base=cache/('models--'+repo.replace('/','--'))
    result={'repo':repo,'ready':False,'verified_bytes':0,'files':0}
    try:
        manifest=json.loads((base/'verified-manifest.json').read_text('utf-8'))
        records=manifest.get('files',[])
        valid={r['file']:r for r in records if Path(r['path']).is_file() and Path(r['path']).stat().st_size==r['size']}
        result.update(files=len(valid),verified_bytes=sum(r['size'] for r in valid.values()))
        result['ready']=manifest.get('status')=='complete' and len(valid)==len(records) and bool(valid)
        if required: result['ready']=result['ready'] and all(name in valid for name in required)
    except (OSError,ValueError,KeyError,TypeError):pass
    result['message']='已下载并校验' if result['ready'] else ('待账号获准并下载' if repo in GATED else '下载未完成')
    return result


def check(config):
    cache=Path(os.getenv('HF_HOME','/data/models/hf'))/'hub'
    models={repo:repository(cache,repo,files if files and not any('*' in f for f in files) else None) for repo,files in PUBLIC}
    models.update({repo:repository(cache,repo,['config.json','model.safetensors']) for repo in GATED})
    comfy=False
    try:
        with urllib.request.urlopen(config.comfy_url+'/system_stats',timeout=2) as r:
            comfy=bool(json.load(r).get('devices'))
    except (OSError,ValueError):pass
    qwen='Comfy-Org/Qwen-Image_ComfyUI'
    model_dir=Path(os.getenv('SCW_MODEL_DIR','/data/models/comfyui'))
    qwen_paths=all((model_dir/Path(f).parent.name/Path(f).name).is_file() for f in QWEN_FILES)
    trellis_repos=['microsoft/TRELLIS.2-4B','microsoft/TRELLIS-image-large']+GATED
    engines={
        'concept_image':{'ready':comfy and models[qwen]['ready'] and qwen_paths and Path(config.trellis_python).is_file(),'missing':[]},
        'image_to_3d':{'ready':all(models[r]['ready'] for r in trellis_repos) and Path(config.trellis_python).is_file(),'missing':[]},
        'remove_bg':{'ready':models['ZhengPeng7/BiRefNet']['ready'] and Path(config.trellis_python).is_file(),'missing':[]},
        'mesh':{'ready':Path(config.blender_python).is_file(),'missing':[]},
        'export':{'ready':bool(shutil.which(config.node)) and bool(shutil.which('toktx',path=os.getenv('SCW_KTX_BIN',os.getenv('PATH','')))),'missing':[]},
    }
    if not comfy:engines['concept_image']['missing'].append('ComfyUI 服务未就绪')
    if not models[qwen]['ready'] or not qwen_paths:engines['concept_image']['missing'].append('Qwen-Image 权重下载与目录挂载未完成')
    if not engines['remove_bg']['ready']:engines['remove_bg']['missing'].append('BiRefNet 权重或推理环境未就绪')
    for repo in trellis_repos:
        if not models[repo]['ready']:engines['image_to_3d']['missing'].append(repo+'：'+models[repo]['message'])
    for key in ['concept_image','image_to_3d']:
        if not Path(config.trellis_python).is_file():engines[key]['missing'].append('推理 Python 环境不存在')
    if not engines['mesh']['ready']:engines['mesh']['missing'].append('Blender 环境不存在')
    if not engines['export']['ready']:engines['export']['missing'].append('Node 或 KTX 压缩工具不存在')
    return {'mode':'production','ready':all(e['ready'] for e in engines.values()),'engines':engines,'models':list(models.values()),'comfy_online':comfy}
