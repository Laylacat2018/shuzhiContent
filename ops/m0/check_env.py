#!/usr/bin/env python3
"""M0 · 硬件与运行环境核对（SPEC 第四部分 §1“运行环境与硬件”）。

只用 Python 标准库；在 GPU 主机（Ubuntu 22.04 或 Windows 11 + WSL2 Ubuntu）里运行：

    python3 ops/m0/check_env.py --data /data --out reports/m0

输出 env_report.md / env_report.json。结论：PASS 达标，WARN 可用但低于建议，FAIL 必须处理。
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import re
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

REQ = {"vram_gb": 24, "cpu_cores": 16, "ram_gb": 64, "model_disk_tb": 2.0, "asset_disk_tb": 2.0, "cuda": (12, 8)}
HOSTS = [  # 出站 HTTPS：模型下载、代码、云服务（SPEC §1 网络）
    ("huggingface.co", "模型权重"), ("github.com", "代码仓库"), ("pypi.org", "Python 包"),
    ("download.pytorch.org", "PyTorch"), ("www.autodl.com", "云 GPU（AutoDL）"), ("cloud.tencent.com", "腾讯云 API"),
    ("api.anthropic.com", "Agent 编排模型"),
]


def run(cmd: list[str], timeout: int = 20) -> tuple[int, str]:
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, (p.stdout + p.stderr).strip()
    except FileNotFoundError:
        return 127, "未安装"
    except subprocess.TimeoutExpired:
        return 124, "超时"


class Report:
    def __init__(self) -> None:
        self.items: list[dict] = []

    def add(self, group: str, name: str, status: str, value: str, need: str, fix: str = "") -> None:
        self.items.append({"group": group, "name": name, "status": status, "value": value, "need": need, "fix": fix})

    @property
    def verdict(self) -> str:
        s = {i["status"] for i in self.items}
        return "FAIL" if "FAIL" in s else "WARN" if "WARN" in s else "PASS"


def is_wsl() -> bool:
    try:
        return "microsoft" in Path("/proc/version").read_text().lower()
    except OSError:
        return False


def check_os(r: Report) -> None:
    sysname = platform.system()
    if sysname == "Windows":
        r.add("系统", "操作系统", "FAIL", f"Windows {platform.release()}", "Ubuntu 22.04 或 Windows 11 + WSL2",
              "TRELLIS.2 官方仅支持 Linux：在 PowerShell（管理员）执行 wsl --install -d Ubuntu-22.04，然后在 WSL 里运行本脚本")
        return
    desc = platform.platform()
    try:
        osr = dict(l.split("=", 1) for l in Path("/etc/os-release").read_text().splitlines() if "=" in l)
        desc = osr.get("PRETTY_NAME", desc).strip('"')
        ok = osr.get("ID") == "ubuntu" and osr.get("VERSION_ID", "").strip('"') in ("22.04", "24.04")
    except OSError:
        ok = False
    r.add("系统", "操作系统", "PASS" if ok else "WARN", desc + ("（WSL2）" if is_wsl() else ""), "Ubuntu 22.04（或 WSL2）",
          "" if ok else "建议使用 Ubuntu 22.04；其他发行版需自行处理依赖")


def check_gpu(r: Report) -> dict:
    code, out = run(["nvidia-smi", "--query-gpu=name,memory.total,driver_version", "--format=csv,noheader,nounits"])
    info: dict = {}
    if code != 0:
        r.add("GPU", "NVIDIA GPU", "FAIL", out[:120] or "未检测到", "RTX 4090 24GB",
              "安装 NVIDIA 驱动（WSL2 只需在 Windows 侧安装最新 Game Ready / Studio 驱动）")
        return info
    name, mem, drv = [x.strip() for x in out.splitlines()[0].split(",")]
    vram = round(int(mem) / 1024, 1)
    info.update(name=name, vram_gb=vram, driver=drv)
    r.add("GPU", "显卡", "PASS" if vram >= REQ["vram_gb"] - 0.5 else "FAIL", f"{name} · {vram} GB", "≥ 24 GB（RTX 4090）",
          "" if vram >= 23.5 else "显存不足 24GB，TRELLIS.2 无法本地运行，需全部走云端")
    code, full = run(["nvidia-smi"])
    m = re.search(r"CUDA Version:\s*([\d.]+)", full)
    if m:
        cv = tuple(int(x) for x in m.group(1).split(".")[:2])
        info["cuda_driver"] = m.group(1)
        r.add("GPU", "驱动支持的 CUDA", "PASS" if cv >= REQ["cuda"] else "FAIL", f"驱动 {drv} · CUDA {m.group(1)}", "≥ 12.8（LichtFeld Studio 要求）",
              "" if cv >= REQ["cuda"] else "升级 NVIDIA 驱动到支持 CUDA 12.8 的版本（R570 及以上）")
    code, nvcc = run(["nvcc", "--version"])
    m = re.search(r"release ([\d.]+)", nvcc)
    r.add("GPU", "CUDA Toolkit（编译用）", "PASS" if m else "WARN", m.group(1) if m else "未安装", "TRELLIS.2 推荐 12.4",
          "" if m else "安装 CUDA Toolkit 12.4（编译 TRELLIS.2 扩展需要），见 setup_gpu_host.sh")
    return info


def check_cpu_ram(r: Report) -> None:
    cores = os.cpu_count() or 0
    r.add("主机", "CPU 线程数", "PASS" if cores >= REQ["cpu_cores"] else "WARN", str(cores), "≥ 16 核（3 个 Blender 无头进程 + COLMAP）",
          "" if cores >= 16 else "CPU 池并发需降为 1–2")
    ram = 0.0
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith("MemTotal"):
                ram = int(line.split()[1]) / 1024 / 1024
    except OSError:
        pass
    status = "PASS" if ram >= REQ["ram_gb"] * 0.95 else ("WARN" if ram >= 32 else "FAIL")
    fix = ""
    if status != "PASS":
        fix = "WSL2 默认只分到一半内存：在 %UserProfile%\\.wslconfig 写 [wsl2] memory=56GB 后 wsl --shutdown" if is_wsl() else "建议补到 64GB"
    r.add("主机", "内存", status, f"{ram:.0f} GB", "≥ 64 GB（模型加载与换载；Step1X-3D 推荐 64GB）", fix)


def check_disk(r: Report, data: Path) -> None:
    target = data if data.exists() else data.parent if data.parent.exists() else Path("/")
    du = shutil.disk_usage(target)
    free_tb, total_tb = du.free / 1e12, du.total / 1e12
    status = "PASS" if free_tb >= 0.5 else ("WARN" if free_tb >= 0.35 else "FAIL")
    r.add("存储", f"数据盘 {target}", status, f"可用 {free_tb:.2f} TB / 共 {total_tb:.2f} TB",
          "模型盘 NVMe ≥ 2TB（全部模型按 300GB 以上预留）+ 资产盘 ≥ 2TB",
          "" if status == "PASS" else "M0 首批模型约 90GB；全部模型与资产需另配 NVMe")
    if is_wsl() and str(target).startswith("/mnt/"):
        r.add("存储", "WSL 数据目录位置", "WARN", str(target), "放在 WSL 的 ext4 文件系统内（如 /data）", "/mnt/c 等 Windows 盘经 9P 访问，模型加载慢数倍")


def check_tools(r: Report) -> None:
    code, out = run(["docker", "version", "--format", "{{.Server.Version}}"])
    r.add("软件", "Docker", "PASS" if code == 0 else "FAIL", out.splitlines()[0][:60] if out else "未安装", "Docker Engine 24+",
          "" if code == 0 else "运行 setup_gpu_host.sh --docker")
    if code == 0:
        code2, info = run(["docker", "info", "--format", "{{json .Runtimes}}"])
        has = "nvidia" in info
        r.add("软件", "NVIDIA Container Toolkit", "PASS" if has else "FAIL", "已注册 nvidia 运行时" if has else "未注册", "容器内可见 GPU",
              "" if has else "运行 setup_gpu_host.sh --docker（安装 nvidia-container-toolkit 并 nvidia-ctk runtime configure）")
    for cmd, name, need in (["git", "--version"], "Git", "必需"), (["conda", "--version"], "Conda", "TRELLIS.2 安装脚本使用"), (["ffmpeg", "-version"], "ffmpeg", "导出球幕 / 视频"):
        code, out = run(cmd)
        r.add("软件", name, "PASS" if code == 0 else ("FAIL" if name == "Git" else "WARN"), out.splitlines()[0][:60] if code == 0 else "未安装", need,
              "" if code == 0 else ("运行 setup_gpu_host.sh --conda" if name == "Conda" else "运行 setup_gpu_host.sh --base"))
    py = sys.version.split()[0]
    r.add("软件", "Python（本脚本）", "PASS", py, "3.10+（Blender 无头模块需 3.11）")


def check_net(r: Report) -> None:
    for host, use in HOSTS:
        t0 = time.time()
        try:
            socket.create_connection((host, 443), timeout=6).close()
            r.add("网络", host, "PASS", f"{(time.time() - t0) * 1000:.0f} ms", use)
        except OSError as e:
            sev = "FAIL" if host in ("huggingface.co", "github.com", "pypi.org") else "WARN"
            r.add("网络", host, sev, f"不可达（{e.__class__.__name__}）", use,
                  "国内网络可设置 HF_ENDPOINT=https://hf-mirror.com 使用镜像" if host == "huggingface.co" else "检查代理 / 防火墙")


def check_gpu_container(r: Report) -> None:
    code, out = run(["docker", "run", "--rm", "--gpus", "all", "nvidia/cuda:12.4.1-base-ubuntu22.04", "nvidia-smi", "-L"], timeout=300)
    r.add("软件", "容器内 GPU 可见（nvidia-smi）", "PASS" if code == 0 and "GPU" in out else "FAIL", out.splitlines()[-1][:80] if out else "失败",
          "SPEC 5.3 第 1 步：容器内 nvidia-smi 可见 GPU", "" if code == 0 else "检查 NVIDIA Container Toolkit 与 Docker 重启")


def to_md(r: Report, gpu: dict) -> str:
    icon = {"PASS": "✅", "WARN": "⚠️", "FAIL": "❌"}
    lines = [f"# M0 环境核对报告", "", f"- 时间：{time.strftime('%Y-%m-%d %H:%M:%S')}", f"- 主机：{platform.node()}",
             f"- 结论：**{icon[r.verdict]} {r.verdict}**", "", "| 分组 | 项目 | 结论 | 实测 | 要求 | 处理建议 |", "| --- | --- | --- | --- | --- | --- |"]
    for i in r.items:
        lines.append(f"| {i['group']} | {i['name']} | {icon[i['status']]} {i['status']} | {i['value']} | {i['need']} | {i['fix']} |")
    return "\n".join(lines) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", default="/data", help="数据根目录（SPEC 5.2）")
    ap.add_argument("--out", default="reports/m0")
    ap.add_argument("--container", action="store_true", help="额外验证容器内 GPU 可见（会拉取 nvidia/cuda 镜像）")
    ap.add_argument("--no-net", action="store_true")
    a = ap.parse_args()
    r = Report()
    check_os(r)
    gpu = check_gpu(r)
    check_cpu_ram(r)
    check_disk(r, Path(a.data))
    check_tools(r)
    if a.container:
        check_gpu_container(r)
    if not a.no_net:
        check_net(r)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "env_report.json").write_text(json.dumps({"verdict": r.verdict, "gpu": gpu, "items": r.items}, ensure_ascii=False, indent=2), "utf-8")
    md = to_md(r, gpu)
    (out / "env_report.md").write_text(md, "utf-8")
    print(md)
    return 0 if r.verdict != "FAIL" else 1


if __name__ == "__main__":
    sys.exit(main())
