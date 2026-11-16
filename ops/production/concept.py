#!/usr/bin/env python3
"""Real ComfyUI Qwen workflow, optional reference img2img/LoRA, BiRefNet transparent PNG."""
import json
import os
from pathlib import Path
import sys
import urllib.request
import uuid

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT))
from ops.m0.samples.comfy_qwen_image import Comfy, DEFAULTS, workflow


def main(o):
    from PIL import Image, PngImagePlugin
    out=Path(o['output']);out.mkdir(parents=True,exist_ok=True)
    c=Comfy(o['url'])
    opts=dict(DEFAULTS,width=int(o.get('size',1024)),height=int(o.get('size',1024)),batch=1)
    if o.get('reference'):
        # Upload only this task's reference to the locally configured ComfyUI.
        boundary=uuid.uuid4().hex;data=Path(o['reference']).read_bytes()
        body=(f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="scw-{uuid.uuid4().hex}.png"\r\nContent-Type: image/png\r\n\r\n').encode()+data+f'\r\n--{boundary}--\r\n'.encode()
        req=urllib.request.Request(c.url+'/upload/image',data=body,headers={'Content-Type':'multipart/form-data; boundary='+boundary})
        ref=json.loads(urllib.request.urlopen(req,timeout=120).read())['name']
    paths=[]
    for i in range(int(o.get('batch',8))):
        seed=int(o['seed'])+i
        wf=workflow(o['prompt'],o.get('negative',''),seed,opts,'scw_real_'+uuid.uuid4().hex)
        if o.get('lora_file'):
            wf['11']={'class_type':'LoraLoaderModelOnly','inputs':{'model':['1',0],'lora_name':o['lora_file'],'strength_model':float(o.get('lora_weight',.8))}}
            wf['4']['inputs']['model']=['11',0]
        if o.get('reference'):
            wf['12']={'class_type':'LoadImage','inputs':{'image':ref}}
            wf['13']={'class_type':'VAEEncode','inputs':{'pixels':['12',0],'vae':['3',0]}}
            wf['8']['inputs']['latent_image']=['13',0];wf['8']['inputs']['denoise']=.65
        pid=c.submit(wf);(out/'active-prompt.json').write_text(json.dumps({'prompt_id':pid}),'utf-8')
        images=c.images(c.wait(pid))
        if not images:raise RuntimeError('ComfyUI 没有输出图片')
        p=out/f'concept-{seed}.png';p.write_bytes(images[0]);paths.append(str(p))
        print(f'ComfyUI 已生成 {i+1}/{o.get("batch",8)}，seed={seed}',flush=True)
    c.free()
    if o.get('remove_bg',True):
        sys.path.insert(0,o['trellis_home'])
        from trellis2.pipelines.rembg import BiRefNet
        model=BiRefNet()
        # This extractor creates float32 inputs; recent Transformers may load the
        # repository's configured fp16 weights. Keep the inference types aligned.
        model.model.float().eval()
        model.cuda()
        for p in paths:
            im=Image.open(p).convert('RGB');im=model(im)
            im.save(p)
        model.cpu();del model
    for i,p in enumerate(paths):
        info=PngImagePlugin.PngInfo()
        info.add_text('AIGC',json.dumps({'label':'AI 生成','model':'Qwen-Image','seed':int(o['seed'])+i,'prompt':o['prompt']},ensure_ascii=False))
        Image.open(p).save(p,pnginfo=info)
    (out/'concept-result.json').write_text(json.dumps(paths),'utf-8')


if __name__=='__main__':main(json.loads(Path(sys.argv[1]).read_text('utf-8')))
