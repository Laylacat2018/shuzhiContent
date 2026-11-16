"""Real V1 prop execution. Durable business state + immutable artifacts; one GPU, three CPU workers.

The demo engine remains unchanged. These workers exclusively complete real-mode tasks
after subprocesses have returned actual files and measurements. Missing engines fail closed.
"""
from __future__ import annotations

import concurrent.futures
import dataclasses
import hashlib
import json
import logging
import os
import re
from pathlib import Path
import shutil
import signal
import subprocess
import threading
import time
import zipfile
import urllib.request

from .files import Files

ROOT = Path(__file__).resolve().parent.parent
log = logging.getLogger("scw.production")


@dataclasses.dataclass
class Config:
    data: Path
    comfy_url: str = "http://127.0.0.1:8188"
    trellis_python: str = "/opt/scw/miniforge3/envs/trellis2/bin/python"
    blender_python: str = "/opt/scw/bpy/bin/python"
    trellis_home: str = "/opt/scw/TRELLIS.2"
    node: str = "node"
    timeout: int = 3600

    @classmethod
    def env(cls, data):
        return cls(Path(data), os.getenv("SCW_COMFY_URL", cls.comfy_url), os.getenv("SCW_TRELLIS_PYTHON", cls.trellis_python),
                   os.getenv("SCW_BPY_PYTHON", cls.blender_python), os.getenv("TRELLIS2_HOME", cls.trellis_home), os.getenv("SCW_NODE", "node"), int(os.getenv("SCW_TASK_TIMEOUT", "3600")))


class Cancelled(Exception):
    pass


class Runtime:
    def __init__(self, host, config: Config):
        self.host, self.cfg = host, config
        self.files = Files(config.data / "files")
        self.instance_lock = None
        if os.name != 'nt':
            import fcntl
            self.instance_lock = (config.data / 'worker.lock').open('a')
            try: fcntl.flock(self.instance_lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                self.instance_lock.close()
                raise RuntimeError('该数据目录已有真实 Worker；单机模式只允许一个 API 实例') from None
        self.stop_event = threading.Event()
        self.pool = concurrent.futures.ThreadPoolExecutor(max_workers=4, thread_name_prefix="scw-real")
        self.active: dict[tuple[str, str], tuple[dict, concurrent.futures.Future]] = {}
        self.gpu_lock = threading.Lock()
        self.thread = None
        self.last_sample = 0
        self.ready_sample = (0, None)

    def readiness(self):
        from .readiness import check
        if time.monotonic()-self.ready_sample[0]>5 or self.ready_sample[1] is None:
            self.ready_sample=(time.monotonic(),check(self.cfg))
        return self.ready_sample[1]

    def require_ready(self, node, remove_bg=False):
        report=self.readiness()
        key=node if node in ('concept_image','image_to_3d','export') else 'mesh'
        missing=list(report['engines'][key]['missing'])
        if key=='concept_image' and remove_bg:
            dep=next(m for m in report['models'] if m['repo']=='ZhengPeng7/BiRefNet')
            if not dep['ready']:missing.append('BiRefNet 权重下载未完成')
        if missing:raise ValueError('引擎尚未就绪：'+'；'.join(missing))

    def state(self, ws):
        return json.loads(self.host.state(ws))

    def event(self, ws, fn, *args):
        return self.host.call(ws, "u_admin", None, fn, list(args))

    def start(self):
        self.thread = threading.Thread(target=self.loop, daemon=True, name="scw-real-dispatch")
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        if self.thread:
            self.thread.join(5)
        self.pool.shutdown(wait=True, cancel_futures=True)
        if self.instance_lock: self.instance_lock.close()

    def loop(self):
        while not self.stop_event.wait(0.5):
            try:
                for key, (_, future) in list(self.active.items()):
                    if future.done():
                        try: future.result()
                        except Exception: log.exception("Worker 意外退出")
                        self.active.pop(key)
                pending=[]
                sample=self.metrics() if time.monotonic()-self.last_sample>2 else None
                for ws in self.host.workspaces():
                    S = self.state(ws)
                    if sample:self.event(ws, "productionMetrics", sample)
                    pending.extend((ws,t) for t in S['tasks'] if t['status']=='queued')
                running_gpu = any(t["queue"] == "gpu" for t, _ in self.active.values())
                running_cpu = sum(t["queue"] != "gpu" for t, _ in self.active.values())
                # Priority is global across workspaces, rather than workspace iteration order.
                for ws,t in sorted(pending,key=lambda row:(row[1]['priority']!='pin',row[1]['created_at'])):
                    if (ws, t["id"]) in self.active or len(self.active) >= 4: continue
                    if t["priority"] == "night" and not (time.localtime().tm_hour >= 22 or time.localtime().tm_hour < 7): continue
                    if t["queue"] == "gpu" and running_gpu: continue
                    if t["queue"] != "gpu" and running_cpu >= 3: continue
                    try:self.require_ready(t['node'],t['params'].get('remove_bg',True))
                    except ValueError:continue  # Wait without consuming retries while dependencies download.
                    self.event(ws, "productionClaim", t["id"])
                    future = self.pool.submit(self.execute, ws, t)
                    self.active[ws, t["id"]] = (t, future)
                    if t["queue"] == "gpu": running_gpu = True
                    else: running_cpu += 1
                if sample:self.last_sample=time.monotonic()
            except Exception:
                log.exception("真实任务调度失败")

    def metrics(self):
        result = {"runtime": {"mode": "production", "workers": {"gpu": 1, "cpu": 3}, "sampled_at": int(time.time() * 1000)}}
        try:
            smi=shutil.which('nvidia-smi') or '/usr/lib/wsl/lib/nvidia-smi'
            raw = subprocess.check_output([smi, "--query-gpu=memory.used,memory.total,utilization.gpu,temperature.gpu,power.draw", "--format=csv,noheader,nounits"], timeout=5, text=True)
            def numeric(value):
                try:return float(value.strip())
                except ValueError:return None
            used, total, util, temp, power = [numeric(x) for x in raw.splitlines()[0].split(",")]
            if used is None or total is None:raise ValueError('GPU memory metrics unavailable')
            result["gpu"] = dict(vram=round(used / 1024, 2), total=round(total / 1024, 2), util=util, temp=temp, power=power)
        except (OSError, ValueError, subprocess.SubprocessError):
            result["runtime"]["gpu_error"] = "无法读取 nvidia-smi"
        disk = shutil.disk_usage(self.cfg.data)
        result["storage"] = {"assets": {"path": str(self.cfg.data), "totalGb": round(disk.total / 2**30, 1), "usedGb": round(disk.used / 2**30, 1)}}
        model_dir=Path(os.getenv('HF_HOME','/data/models/hf'))
        if model_dir.exists():
            model_disk=shutil.disk_usage(model_dir)
            result['storage']['models']={'path':str(model_dir),'totalGb':round(model_disk.total/2**30,1),'usedGb':round(model_disk.used/2**30,1)}
        return result

    def cancelled(self, ws, tid):
        if self.stop_event.is_set(): return True
        return next(t for t in self.state(ws)["tasks"] if t["id"] == tid)["status"] != "running"

    def command(self, ws, t, argv, folder, env=None):
        """Argument arrays only; subprocess group is terminated on cancellation, shutdown or timeout."""
        logfile = folder / ("process-" + str(time.time_ns()) + ".log")
        options = {"start_new_session": True} if os.name != "nt" else {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
        command_env = dict(os.environ, **(env or {}))
        if os.getenv('SCW_KTX_BIN'):
            command_env['PATH'] = os.environ['SCW_KTX_BIN'] + os.pathsep + command_env.get('PATH', '')
        with logfile.open("wb") as output:
            p = subprocess.Popen([str(a) for a in argv], cwd=ROOT, stdout=output, stderr=subprocess.STDOUT, env=command_env, **options)
            started, last_tail, offset = time.monotonic(), 0, 0
            try:
                while p.poll() is None:
                    if self.cancelled(ws, t["id"]): raise Cancelled()
                    if time.monotonic() - started > self.cfg.timeout: raise TimeoutError("执行超时，已停止子进程")
                    if time.monotonic() - last_tail > 2:
                        with logfile.open("rb") as inp:
                            inp.seek(offset); chunk = inp.read(16_384); offset = inp.tell()
                        text = chunk.decode("utf-8", "replace").strip()
                        progress={"log":text[-3000:] if text else "真实引擎运行中，等待文件结果","metrics":{"elapsed":round(time.monotonic()-started)}}
                        stages=re.findall(r'阶段 ([1-5])/5',text) if t['node']=='mesh_optimize' else []
                        if stages:progress.update(progress=(int(stages[-1])-1)/5);progress['metrics']['stage']=int(stages[-1])
                        self.event(ws,"productionProgress",t['id'],progress)
                        last_tail = time.monotonic()
                    time.sleep(0.25)
            finally:
                if p.poll() is None:
                    if os.name != "nt": os.killpg(p.pid, signal.SIGTERM)
                    else: p.terminate()
                    try: p.wait(5)
                    except subprocess.TimeoutExpired:
                        if os.name != "nt": os.killpg(p.pid, signal.SIGKILL)
                        else: p.kill()
                        p.wait(5)
        if p.returncode:
            tail = logfile.read_bytes()[-6000:].decode("utf-8", "replace")
            raise RuntimeError(tail)
        return logfile

    def mesh(self, ws, t, folder, src, operation, preset, mark=None):
        request = dict(input=str(src), output=str(folder / "mesh.glb"), blend=str(folder / "project.blend"), report=str(folder / "mesh.json"),
                       operation=operation, preset=preset, mark=mark, threads=4)
        req = folder / "mesh-request.json"; req.write_text(json.dumps(request, ensure_ascii=False), "utf-8")
        self.command(ws, t, [self.cfg.blender_python, ROOT / "ops/production/mesh_pipeline.py", req], folder)
        result = json.loads((folder / "mesh.json").read_text("utf-8"))
        return result

    def execute(self, ws, t):
        folder = self.cfg.data / "runs" / ws / t["id"] / str(time.time_ns())
        folder.mkdir(parents=True, exist_ok=True)
        t = next(x for x in self.state(ws)["tasks"] if x["id"] == t["id"])
        try:
            if t["queue"] == "gpu":
                with self.gpu_lock:
                    out = self.perform(ws, t, folder)
            else:
                out = self.perform(ws, t, folder)
            if not self.cancelled(ws, t["id"]): self.event(ws, "productionComplete", t["id"], out)
        except Cancelled:
            if t["node"] == "concept_image":
                self.cancel_comfy(folder)
            # Keep queued on shutdown; user cancellations are already durable.
            if self.stop_event.is_set():
                with self.host.lock:
                    self.host.query(ws, "u_admin", None, f"(E.task({json.dumps(t['id'])}).status = 'queued', true)")
                    self.host.save_all()
        except Exception as e:
            error = str(e)[-5000:]
            self.event(ws, "productionFail", t["id"], error, "out of memory" in error.lower() or "cuda oom" in error.lower())
            log.error("%s/%s: %s", ws, t["id"], error[-600:])

    def cancel_comfy(self, folder):
        """Interrupt only our active prompt, preserving unrelated ComfyUI work."""
        try:
            pid = json.loads((folder / 'active-prompt.json').read_text('utf-8'))['prompt_id']
            from ops.m0.samples.comfy_qwen_image import Comfy
            c = Comfy(self.cfg.comfy_url)
            queue = c._req('GET', '/queue')
            if any(row[1] == pid for row in queue.get('queue_running', [])):
                c._req('POST', '/interrupt', {})
                c.free()
            elif any(row[1] == pid for row in queue.get('queue_pending', [])):
                c._req('POST', '/queue', {'delete': [pid]})
        except (OSError, KeyError, ValueError):
            log.exception('取消 ComfyUI 任务失败')

    def file_result(self, ws, path, name=None, media="model/gltf-binary"):
        f = self.files.put(ws, name or path.name, path, media)
        return {"file_id": f["file_id"], "file_url": f["url"], "file_sha256": f["sha256"], "file_size": f["size"]}

    def perform(self, ws, t, folder):
        S = self.state(ws)
        version = next((v for v in S["versions"] if v["id"] == t.get("version_id")), None)
        asset = next((a for a in S["assets"] if a["id"] == t.get("asset_id")), None)
        preset = S["settings"]["presets"][t["params"].get("preset") or (version or {}).get("preset") or (asset or {}).get("preset") or "quest3"]
        if t["node"] == "concept_image":
            request = dict(t["params"], url=self.cfg.comfy_url, output=str(folder), trellis_home=self.cfg.trellis_home)
            job = next((j for j in S["jobs"] if j["id"] == t.get("job_id")), {})
            refs = job.get("ref_images", [])
            if refs: request["reference"] = str(self.files.path(ws, refs[0]["file_id"]))
            if t["params"].get("lora"):
                model = next(m for m in S["models"] if m["id"] == t["params"]["lora"])
                request["lora_file"] = model["file_name"]
            req = folder / "concept-request.json"; req.write_text(json.dumps(request, ensure_ascii=False), "utf-8")
            self.command(ws, t, [self.cfg.trellis_python, ROOT / "ops/production/concept.py", req], folder, {"TRELLIS2_HOME": self.cfg.trellis_home, "HF_HOME": os.getenv("HF_HOME", "/data/models/hf")})
            paths = json.loads((folder / "concept-result.json").read_text("utf-8"))
            chain = [{"stage": "概念图", "model_id": t["model_id"], "model_name": "Qwen-Image", "license": "Apache-2.0"}]
            if request.get("remove_bg"): chain.append({"stage": "去背景", "model_id": "birefnet", "model_name": "BiRefNet", "license": "MIT"})
            if request.get("lora"): chain.append({"stage": "风格 LoRA", "model_id": request["lora"], "model_name": model["name"], "license": model["license_type"]})
            images = []
            for p in paths:
                f = self.files.put(ws, Path(p).name, Path(p), "image/png")
                images.append(dict(file_id=f["file_id"], url=f["url"], sha256=f["sha256"]))
            return dict(images=images, license_chain=chain)
        if t["node"] == "image_to_3d":
            from ops.m0.samples.comfy_qwen_image import Comfy
            try: Comfy(self.cfg.comfy_url).free()
            except OSError: pass
            metric = self.metrics().get("gpu")
            if not metric or metric["total"] - metric["vram"] < 17:
                raise RuntimeError("空闲显存不足 17GB，拒绝加载 TRELLIS.2；请先释放其他 GPU 工作负载")
            c = next(c for c in S["concepts"] if c["id"] == t["concept_id"])
            self.files.verify(ws, c["file_id"])
            job=next(j for j in S['jobs'] if j['id']==t['job_id'])
            mark = {"label": "AI 复原 · AI 生成" if job.get('ai_restore') else "AI 生成", "model": "TRELLIS.2-4B", "concept_model": "Qwen-Image", "seed": t["params"]["seed"], "generated": True, "time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
            argv = [self.cfg.trellis_python, ROOT / "ops/m0/samples/trellis2_run.py", "--no-retry", "--image", self.files.path(ws, c["file_id"]), "--out", folder / "raw.glb", "--resolution", str(t["params"].get("resolution", 1024)), "--texture", str(t["params"].get("texture", 2048)), "--seed", str(t["params"]["seed"]), "--steps", str(t["params"].get("steps", 25))]
            self.command(ws, t, argv, folder, {"TRELLIS2_HOME": self.cfg.trellis_home, "HF_HOME": os.getenv("HF_HOME", "/data/models/hf")})
            stats = self.mesh(ws, t, folder, folder / "raw.glb", "inspect", preset, mark)
            file = self.file_result(ws, folder / "mesh.glb", "raw.glb")
            model_meta=json.loads((folder/'raw.json').read_text('utf-8'))
            return dict(stats=stats["stats"], file=file, aigc_mark=mark, vram_peak_gb=model_meta['vram_peak_gb'])
        if t["node"] in ("mesh_optimize", "mesh_fix", "manual_import"):
            fid = t["params"].get("file_id") if t["node"] == "manual_import" else version["file_id"]
            if t["node"] == "mesh_optimize": fid = version.get("raw_file_id") or fid
            self.files.verify(ws, fid)
            result = self.mesh(ws, t, folder, self.files.path(ws, fid), "optimize" if t["node"] == "mesh_optimize" else "fix" if t["node"] == "mesh_fix" else "inspect", preset, version.get("aigc_mark"))
            blend = self.files.put(ws, "project.blend", folder / "project.blend")
            return dict(stats=result["stats"], file=self.file_result(ws, folder / "mesh.glb"), blend_file_id=blend["file_id"])
        if t["node"] == "auto_qa":
            self.files.verify(ws, version["file_id"])
            result = self.mesh(ws, t, folder, self.files.path(ws, version["file_id"]), "qa", preset, version.get("aigc_mark"))
            result["sha256"] = version["file_sha256"]
            return result
        if t["node"] == "export": return self.export(ws, t, folder, S)
        raise RuntimeError("未接入的真实节点：" + t["node"])

    def export(self, ws, t, folder, S):
        ex = next(e for e in S["exports"] if e["id"] == t["export_id"])
        def validate_approval():
            live=self.state(ws)
            for vid in ex['version_ids']:
                v=next(v for v in live['versions'] if v['id']==vid)
                a=next(a for a in live['assets'] if a['id']==v['asset_id'])
                qa=next(q for q in live['qa'] if q['id']==v['qa_id'])
                if not v.get('approved') or a['current_version']!=vid or qa['file_sha256']!=v['file_sha256']:
                    raise RuntimeError('导出审核版本已变化，请重新创建导出任务')
                chain=self.host.query(ws,'u_admin',None,f"E.chainCheck(E.version({json.dumps(vid)}).license_chain,E.scopeOf({json.dumps(a['project_id'])},{json.dumps(a.get('job_id'))}))")
                if not chain['ok']:raise RuntimeError('导出许可链已变化或到期，交付已阻断')
        validate_approval()
        snapshot = [];validations={}
        for vid in ex["version_ids"]:
            v = next(v for v in S["versions"] if v["id"] == vid)
            a = next(a for a in S["assets"] if a["id"] == v["asset_id"])
            if not v.get("approved") or a["current_version"] != vid: raise RuntimeError("导出版本已变化，请重新创建导出任务")
            qa = next(q for q in S["qa"] if q["id"] == v["qa_id"])
            if qa["file_sha256"] != v["file_sha256"]: raise RuntimeError("质检文件与导出文件不一致")
            self.files.verify(ws, v["file_id"])
            src = self.files.path(ws, v["file_id"])
            dst = folder / "assets" / f"{a['code']}_v{v['version']}.glb"; dst.parent.mkdir(exist_ok=True)
            validation_log=self.command(ws, t, [self.cfg.node, ROOT / "tools/real_export.mjs", src, dst], folder)
            validations[vid]=json.loads(validation_log.read_text('utf-8').strip().splitlines()[-1])
            budget=S['settings']['presets'].get(v.get('preset') or a.get('preset'),S['settings']['presets']['quest3'])
            if dst.stat().st_size > budget['size_mb'] * 2**20: raise RuntimeError(a['code']+' 压缩后仍超过文件预算，需要重新优化')
            snapshot.append((a, v, dst))
        manifest = ex["manifest"]
        manifest["production"] = True
        for entry, (a, v, dst) in zip(manifest["assets"], snapshot):
            entry.update(file="assets/" + dst.name, source_sha256=v["file_sha256"], sha256=hashlib.sha256(dst.read_bytes()).hexdigest(), compression={"mesh": "Draco", "texture": "KTX2"},validation=validations[v['id']])
        (folder / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), "utf-8")
        (folder / "index.html").write_text(viewer(["assets/" + x[2].name for x in snapshot], ex["settings"].get("aigcVisible", True)), "utf-8")
        shutil.copytree(ROOT / "dist/vendor/three", folder / "vendor/three")
        if "raw" in ex["targets"]:
            raw = folder / "source"; raw.mkdir()
            for a, v, _ in snapshot:
                shutil.copyfile(self.files.path(ws, v["file_id"]), raw / f"{a['code']}.glb")
                if v.get("blend_file_id"): shutil.copyfile(self.files.path(ws, v["blend_file_id"]), raw / f"{a['code']}.blend")
        (folder / "交付说明.txt").write_text("通过 HTTP 服务打开 index.html；WebXR 需 HTTPS 或 localhost。\n" + ("本交付包含 AI 生成内容。\n" if ex["settings"].get("aigcVisible", True) else "") + ("已记录真机测试。" if ex["deviceTested"] else "未经真机验证。"), "utf-8")
        package = folder / (ex["code"] + ".zip")
        included = []
        with zipfile.ZipFile(package, "w", zipfile.ZIP_DEFLATED) as z:
            for p in sorted(folder.rglob("*")):
                rel = p.relative_to(folder)
                if p.is_file() and p != package and not p.name.endswith(".log"):
                    z.write(p, str(rel)); included.append({"name": str(rel), "mb": round(p.stat().st_size / 2**20, 3)})
        validate_approval()  # Recheck after compression, immediately before publishing the immutable ZIP.
        f = self.files.put(ws, package.name, package, "application/zip")
        return dict(file_id=f["file_id"], download_url=f["url"], files=included, size_mb=round(f["size"] / 2**20, 3), manifest=manifest)


def viewer(files, visible):
    return """<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>道具交付</title><style>body{margin:0;background:#202624;color:white}#label{position:fixed;bottom:15px;left:15px}</style>
<div id="label">""" + ("AI 生成内容" if visible else "") + """</div>
<script type="importmap">{"imports":{"three":"./vendor/three/three.module.js"}}</script><script type="module">
import * as THREE from 'three';import {OrbitControls} from './vendor/three/jsm/controls/OrbitControls.js';import {GLTFLoader} from './vendor/three/jsm/loaders/GLTFLoader.js';import {DRACOLoader} from './vendor/three/jsm/loaders/DRACOLoader.js';import {KTX2Loader} from './vendor/three/jsm/loaders/KTX2Loader.js';import {VRButton} from './vendor/three/jsm/webxr/VRButton.js';
const r=new THREE.WebGLRenderer({antialias:true});r.setSize(innerWidth,innerHeight);r.outputEncoding=THREE.sRGBEncoding;r.xr.enabled=true;document.body.appendChild(r.domElement);document.body.appendChild(VRButton.createButton(r));
const s=new THREE.Scene();s.add(new THREE.HemisphereLight(0xffffff,0x444444,1.4));const l=new THREE.DirectionalLight(0xffffff,1.5);l.position.set(3,4,5);s.add(l);
const c=new THREE.PerspectiveCamera(50,innerWidth/innerHeight,.01,200);c.position.set(3,2,4);const controls=new OrbitControls(c,r.domElement);
const draco=new DRACOLoader().setDecoderPath('vendor/three/draco/');const ktx=new KTX2Loader().setTranscoderPath('vendor/three/basis/').detectSupport(r);const loader=new GLTFLoader().setDRACOLoader(draco).setKTX2Loader(ktx);window.__SCW_VIEWER={loaded:0,failed:[]};
const files=""" + json.dumps(files) + """;files.forEach((f,i)=>loader.load(f,g=>{g.scene.position.x=i*1.2;s.add(g.scene);window.__SCW_VIEWER.loaded++},undefined,e=>{document.querySelector('#label').textContent='加载失败，请通过 HTTP 服务打开交付包';window.__SCW_VIEWER.failed.push(String(e));console.error(e)}));r.setAnimationLoop(()=>{controls.update();r.render(s,c)});addEventListener('resize',()=>{c.aspect=innerWidth/innerHeight;c.updateProjectionMatrix();r.setSize(innerWidth,innerHeight)});
</script></html>"""
