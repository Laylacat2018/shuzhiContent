#!/usr/bin/env python3
"""M0 样例 · Blender 无头优化（N3 节点的第一步：减面 + 统计 + 导出）。

用 Blender 4.2 LTS 的 Python 模块（bpy）运行，不需要图形界面、不占用 GPU：

    /opt/scw/bpy/bin/python ops/m0/samples/blender_optimize.py --in out/raw.glb --out out/quest3.glb --tris 20000

输出优化后的 GLB 与统计 JSON（三角形、顶点、材质、贴图尺寸、非流形边、包围盒、原点偏移），
统计口径与平台质检规则 Q01–Q07 一致，M2 质检引擎复用本函数。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time


def reset():
    import bpy
    bpy.ops.wm.read_factory_settings(use_empty=True)


def mesh_objects():
    import bpy
    return [o for o in bpy.context.scene.objects if o.type == "MESH"]


def stats(objs) -> dict:
    import bmesh
    import bpy
    from mathutils import Vector
    deps = bpy.context.evaluated_depsgraph_get()
    tris = verts = nonmanifold = 0
    mats, tex = set(), {}
    lo, hi = Vector((1e9, 1e9, 1e9)), Vector((-1e9, -1e9, -1e9))
    for o in objs:
        ev = o.evaluated_get(deps)
        m = ev.to_mesh()
        bm = bmesh.new(); bm.from_mesh(m)
        tris += sum(len(f.verts) - 2 for f in bm.faces)
        verts += len(bm.verts)
        nonmanifold += sum(1 for e in bm.edges if not e.is_manifold and not e.is_boundary)
        for v in bm.verts:
            w = o.matrix_world @ v.co
            lo = Vector(map(min, lo, w)); hi = Vector(map(max, hi, w))
        bm.free(); ev.to_mesh_clear()
        for slot in o.material_slots:
            if slot.material:
                mats.add(slot.material.name)
                if slot.material.node_tree:
                    for n in slot.material.node_tree.nodes:
                        if n.type == "TEX_IMAGE" and n.image:
                            tex[n.image.name] = list(n.image.size)
    size = hi - lo
    # 平台坐标约定为 Y 轴向上（glTF）；Blender 内为 Z 向上：底部中心 = (cx, cy, zmin)
    base = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))
    return {"tris": tris, "verts": verts, "materials": len(mats), "textures": tex, "max_texture": max([max(s) for s in tex.values()] or [0]),
            "non_manifold_edges": nonmanifold, "size_m": [round(size.x, 3), round(size.z, 3), round(size.y, 3)],
            "origin_offset_cm": round(base.length * 100, 2)}


def optimize(src: str, dst: str, target_tris: int, draco: bool) -> dict:
    import bpy
    reset()
    t0 = time.time()
    bpy.ops.import_scene.gltf(filepath=src)
    objs = mesh_objects()
    if not objs:
        raise RuntimeError("GLB 中没有网格")
    before = stats(objs)
    t_import = time.time() - t0
    # 合并为单个网格，便于统一减面与单材质预算
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    ratio = min(1.0, target_tris / max(1, before["tris"]))
    if ratio < 1.0:
        mod = obj.modifiers.new("Decimate", "DECIMATE")
        mod.decimate_type = "COLLAPSE"
        mod.ratio = ratio
        mod.use_collapse_triangulate = True
        bpy.ops.object.modifier_apply(modifier=mod.name)
    # 原点归位到底部中心（Q07）
    bpy.ops.object.origin_set(type="ORIGIN_GEOMETRY", center="BOUNDS")
    zmin = min((obj.matrix_world @ v.co).z for v in obj.data.vertices)
    bpy.context.scene.cursor.location = (obj.location.x, obj.location.y, zmin)
    bpy.ops.object.origin_set(type="ORIGIN_CURSOR")
    obj.location = (0, 0, 0)
    after = stats([obj])
    os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
    kw = dict(filepath=dst, export_format="GLB", use_selection=False)
    if draco:
        kw.update(export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=6)
    bpy.ops.export_scene.gltf(**kw)
    return {"engine": "Blender " + bpy.app.version_string, "input": src, "output": dst, "target_tris": target_tris, "ratio": round(ratio, 4),
            "draco": draco, "before": before, "after": after, "import_seconds": round(t_import, 2), "seconds": round(time.time() - t0, 2),
            "file_mb": round(os.path.getsize(dst) / 2**20, 3)}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in", dest="src", required=True)
    ap.add_argument("--out", dest="dst", required=True)
    ap.add_argument("--tris", type=int, default=20000, help="三角形上限（Quest 3 道具 20,000；WebXR 10,000）")
    ap.add_argument("--draco", action="store_true", help="导出时启用 Draco 网格压缩")
    a = ap.parse_args()
    r = optimize(a.src, a.dst, a.tris, a.draco)
    with open(os.path.splitext(a.dst)[0] + ".json", "w", encoding="utf-8") as f:
        json.dump(r, f, ensure_ascii=False, indent=2)
    print(json.dumps(r, ensure_ascii=False))
    ok = r["after"]["tris"] <= a.tris
    return 0 if ok else 3


if __name__ == "__main__":
    code = main()
    sys.stdout.flush(); sys.stderr.flush()
    os._exit(code)  # bpy 模块在解释器退出清理阶段可能段错误（Blender 4.2 已知问题），结果已落盘后直接退出
