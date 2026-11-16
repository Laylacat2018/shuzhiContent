#!/usr/bin/env python3
"""CPU Blender worker: inspect, low-poly processing, real UV/PBR baking, repair and Q01-Q07/Q09.

Invoked with a JSON request path, never executes client-provided scripts.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import struct
import sys
import time


def glb_json(path):
    data = Path(path).read_bytes()
    if len(data) < 20 or data[:4] != b"glTF" or struct.unpack_from("<I", data, 4)[0] != 2:
        raise ValueError("不是 glTF 2.0 GLB")
    if struct.unpack_from("<I", data, 8)[0] != len(data): raise ValueError("GLB 长度不匹配")
    n, typ = struct.unpack_from("<II", data, 12)
    if typ != 0x4E4F534A: raise ValueError("GLB 缺少 JSON chunk")
    return json.loads(data[20:20+n])


def stamp(path, mark):
    if not mark: return
    data = Path(path).read_bytes(); n = struct.unpack_from("<I", data, 12)[0]
    doc = glb_json(path)
    doc.setdefault("asset", {}).setdefault("extras", {})["AIGC"] = mark
    raw = json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode()
    raw += b" " * (-len(raw) % 4)
    chunks = struct.pack("<II", len(raw), 0x4E4F534A) + raw + data[20+n:]
    Path(path).write_bytes(b"glTF" + struct.pack("<II", 2, len(chunks)+12) + chunks)


def objects():
    import bpy
    return [o for o in bpy.context.scene.objects if o.type == 'MESH']


def activate(obj):
    import bpy
    bpy.ops.object.select_all(action='DESELECT')
    obj.hide_set(False); obj.select_set(True); bpy.context.view_layer.objects.active = obj


def remove_open_fragments(bm):
    """Remove tiny disconnected open scraps; preserve the main mesh and closed pieces."""
    import bmesh
    pending=set(bm.faces);components=[]
    while pending:
        faces={pending.pop()};stack=list(faces)
        while stack:
            face=stack.pop()
            for edge in face.edges:
                neighbors={f for f in edge.link_faces if f in pending}
                pending.difference_update(neighbors);faces.update(neighbors);stack.extend(neighbors)
        components.append(faces)
    largest=max((sum(f.calc_area() for f in faces) for faces in components),default=0)
    remove=[]
    for faces in components:
        if len(faces)<=12 and sum(f.calc_area() for f in faces)<largest*.01 and any(e.is_boundary for f in faces for e in f.edges):
            remove.extend(faces)
    if remove:
        bmesh.ops.delete(bm,geom=remove,context='FACES')
        loose=[v for v in bm.verts if not v.link_faces]
        if loose:bmesh.ops.delete(bm,geom=loose,context='VERTS')
    return len(remove)


def topology_signature(mesh):
    from array import array
    coordinates=array('f',[0])*len(mesh.vertices)*3
    corners=array('i',[0])*len(mesh.loops)
    mesh.vertices.foreach_get('co',coordinates);mesh.loops.foreach_get('vertex_index',corners)
    return hashlib.sha256(coordinates.tobytes()+corners.tobytes()).digest()


def clean_surface(obj):
    import bmesh
    bm=bmesh.new();bm.from_mesh(obj.data)
    bmesh.ops.remove_doubles(bm,verts=list(bm.verts),dist=.00001)
    bmesh.ops.dissolve_degenerate(bm,edges=list(bm.edges),dist=.000001)
    removed=remove_open_fragments(bm)
    if removed:print(f'已移除 {removed} 个小型孤立开放碎面，保留主体和封闭部件',flush=True)
    boundary=[e for e in bm.edges if e.is_boundary]
    if boundary:bmesh.ops.holes_fill(bm,edges=boundary,sides=12)
    bmesh.ops.triangulate(bm,faces=list(bm.faces))
    bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces));bm.to_mesh(obj.data);bm.free()


def uv_overlap(objs, size=512):
    """Rasterize UV triangle interiors. Shared edges are excluded from overlap counts."""
    import numpy as np
    pixels = np.zeros((size, size), dtype=np.uint16)
    missing = False
    for o in objs:
        m = o.data; m.calc_loop_triangles()
        if not m.uv_layers.active:
            missing = True; continue
        uv = m.uv_layers.active.data
        for tri in m.loop_triangles:
            a, b, c = [np.array(uv[i].uv) * size for i in tri.loops]
            lo = np.floor(np.minimum(np.minimum(a, b), c)).astype(int).clip(0, size-1)
            hi = np.ceil(np.maximum(np.maximum(a, b), c)).astype(int).clip(0, size-1)
            det = (b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1])
            if abs(det) < 1e-10: continue
            yy, xx = np.mgrid[lo[1]:hi[1]+1, lo[0]:hi[0]+1]; xx = xx+.5; yy = yy+.5
            u = ((b[1]-c[1])*(xx-c[0])+(c[0]-b[0])*(yy-c[1]))/det
            v = ((c[1]-a[1])*(xx-c[0])+(a[0]-c[0])*(yy-c[1]))/det
            mask = (u > 1e-6) & (v > 1e-6) & (1-u-v > 1e-6)
            pixels[lo[1]:hi[1]+1, lo[0]:hi[0]+1] += mask
    covered = int((pixels > 0).sum())
    return round(float((pixels > 1).sum()) / max(covered, 1) * 100, 3), missing


def measure(objs, path):
    import bpy, bmesh
    from mathutils import Vector
    tris = verts = nonmanifold = flipped = 0
    mats, textures = set(), {}
    lo, hi = Vector((1e9,)*3), Vector((-1e9,)*3)
    for o in objs:
        bm = bmesh.new(); bm.from_mesh(o.data)
        tris += sum(len(f.verts)-2 for f in bm.faces); verts += len(bm.verts)
        # glTF splits vertices at UV/material/normal seams; topology checks weld a copy.
        bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=.00001)
        loose = [v for v in bm.verts if not v.link_faces]
        if loose: bmesh.ops.delete(bm, geom=loose, context='VERTS')
        nonmanifold += sum(not e.is_manifold for e in bm.edges)
        inconsistent = set()
        for e in bm.edges:
            if e.is_manifold and not e.is_contiguous: inconsistent.update(e.link_faces)
        if bm.faces and all(e.is_manifold for e in bm.edges) and bm.calc_volume(signed=True) < 0:
            flipped += len(bm.faces)
        else: flipped += len(inconsistent)
        for v in bm.verts:
            w = o.matrix_world @ v.co
            lo = Vector(map(min, lo, w)); hi = Vector(map(max, hi, w))
        bm.free()
        for s in o.material_slots:
            if s.material:
                mats.add(s.material.name)
                if s.material.node_tree:
                    for n in s.material.node_tree.nodes:
                        if n.type == 'TEX_IMAGE' and n.image: textures[n.image.name] = list(n.image.size)
    size = hi-lo; base = Vector(((lo.x+hi.x)/2, (lo.y+hi.y)/2, lo.z))
    overlap, missing_uv = uv_overlap(objs)
    return dict(tris=tris, verts=verts, materials=len(mats), texture=max([max(x) for x in textures.values()] or [0]), textures=textures,
                file_mb=round(Path(path).stat().st_size/2**20, 3), nonmanifold=nonmanifold, flipped=flipped,
                uvOverlap=overlap, missing_uv=missing_uv, size_m=[round(size.x,4),round(size.z,4),round(size.y,4)], origin_offset_m=round(base.length,6),
                pbr=True, normal_detail='需目检', measurements='Blender actual file')


def bake(high, low, tex_size):
    import bpy
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'; scene.cycles.device = 'CPU'; scene.cycles.samples = 1
    scene.render.bake.use_selected_to_active = True
    scene.render.bake.cage_extrusion = max(max(low.dimensions) * .015, .005)
    scene.render.bake.max_ray_distance = max(low.dimensions) * .06
    scene.render.bake.margin = 8
    target = bpy.data.materials.new('BakedPBR'); target.use_nodes = True
    low.data.materials.clear(); low.data.materials.append(target)
    pbr = target.node_tree.nodes.get('Principled BSDF')
    images = {}
    def run(channel, typ, color_space):
        img = bpy.data.images.new('SCW_'+channel, width=tex_size, height=tex_size, alpha=False)
        img.colorspace_settings.name = color_space
        node = target.node_tree.nodes.new('ShaderNodeTexImage'); node.image = img; target.node_tree.nodes.active = node
        bpy.ops.object.select_all(action='DESELECT'); high.select_set(True); low.select_set(True); bpy.context.view_layer.objects.active = low
        bpy.ops.object.bake(type=typ)
        images[channel] = (img,node)
    scene.render.bake.use_pass_direct = False; scene.render.bake.use_pass_indirect = False; scene.render.bake.use_pass_color = True
    run('BaseColor','DIFFUSE','sRGB')
    run('Normal','NORMAL','Non-Color')
    # Convert each source PBR scalar to emission for physically independent channel bakes.
    backups = []
    for slot in high.material_slots:
        mat = slot.material
        if not mat or not mat.use_nodes: continue
        tree = mat.node_tree; p = next((n for n in tree.nodes if n.type == 'BSDF_PRINCIPLED'),None)
        output = next((n for n in tree.nodes if n.type == 'OUTPUT_MATERIAL'),None)
        if not p or not output: continue
        prev = [(l.from_socket,l.to_socket) for l in list(tree.links) if l.to_node == output]
        for l in list(tree.links):
            if l.to_node == output: tree.links.remove(l)
        em = tree.nodes.new('ShaderNodeEmission'); tree.links.new(em.outputs['Emission'],output.inputs['Surface'])
        backups.append((tree,p,em,prev))
    for channel in ['Roughness','Metallic']:
        for tree,p,em,prev in backups:
            for l in list(em.inputs['Color'].links): tree.links.remove(l)
            inp = p.inputs[channel]
            if inp.is_linked: tree.links.new(inp.links[0].from_socket,em.inputs['Color'])
            else: em.inputs['Color'].default_value = (inp.default_value,)*3+(1,)
        run(channel,'EMIT','Non-Color')
    for tree,p,em,prev in backups:
        tree.nodes.remove(em)
        for a,b in prev: tree.links.new(a,b)
    tree = target.node_tree
    tree.links.new(images['BaseColor'][1].outputs['Color'],pbr.inputs['Base Color'])
    normal = tree.nodes.new('ShaderNodeNormalMap'); tree.links.new(images['Normal'][1].outputs['Color'],normal.inputs['Color']);tree.links.new(normal.outputs['Normal'],pbr.inputs['Normal'])
    for ch in ['Roughness','Metallic']: tree.links.new(images[ch][1].outputs['Color'],pbr.inputs[ch])
    for img,node in images.values(): img.pack()


def main(request):
    import bpy, bmesh
    started = time.monotonic()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.render.threads_mode='FIXED'; bpy.context.scene.render.threads=request.get('threads',4)
    source = Path(request['input']); doc = glb_json(source)
    bpy.ops.import_scene.gltf(filepath=str(source))
    objs = objects()
    if not objs: raise ValueError('GLB 不包含网格')
    operation = request['operation']; target = int(request['preset']['tris'])
    if operation in ['optimize','fix']:
        bpy.ops.object.select_all(action='DESELECT')
        for o in objs:o.select_set(True)
        bpy.context.view_layer.objects.active = objs[0]
        if len(objs)>1:bpy.ops.object.join()
        low = bpy.context.view_layer.objects.active
        bpy.ops.object.transform_apply(location=False,rotation=True,scale=True)
        high = None
        if operation == 'optimize':
            high = low.copy(); high.data = low.data.copy(); bpy.context.collection.objects.link(high); high.name='SourceHigh'
            bm=bmesh.new();bm.from_mesh(low.data)
            bmesh.ops.remove_doubles(bm,verts=list(bm.verts),dist=.00001)
            bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces))
            needs_repair=any(not e.is_manifold for e in bm.edges)
            bm.to_mesh(low.data);bm.free()
            activate(low)
            print('阶段 1/5：预算减面与几何清理',flush=True)
            tris = sum(len(p.vertices)-2 for p in low.data.polygons)
            if tris>target and not needs_repair:
                dec = low.modifiers.new('BudgetDecimate','DECIMATE');dec.ratio=min(1,target/max(tris,1)*.98);dec.use_collapse_triangulate=True
                activate(low);bpy.ops.object.modifier_apply(modifier=dec.name)
            print('阶段 2/5：QuadriFlow 自动重拓扑',flush=True)
            topology=bmesh.new();topology.from_mesh(low.data)
            needs_repair=needs_repair or any(not edge.is_manifold for edge in topology.edges)
            topology.free()
            if needs_repair:
                # Generated surfaces can contain intersecting sheets or open edges.
                # Rebuild only the low mesh; keep the textured high mesh for baking.
                low.data.remesh_voxel_size=max(low.dimensions)/96
                low.data.remesh_voxel_adaptivity=.1
                repaired=bpy.ops.object.voxel_remesh()
                if 'FINISHED' not in repaired:raise RuntimeError('体素修复未完成，请转人工处理')
                print('已对低模执行体素拓扑修复，高模保留用于 PBR 烘焙',flush=True)
                # Voxel rebuilding can expand to hundreds of thousands of faces.
                # Bound QuadriFlow's input, rather than feeding it the voxel grid.
                count=sum(len(p.vertices)-2 for p in low.data.polygons)
                if count>target*4:
                    dec=low.modifiers.new('RemeshInputBudget','DECIMATE');dec.ratio=target*4/count;dec.use_collapse_triangulate=True
                    bpy.ops.object.modifier_apply(modifier=dec.name)
            # Blender 4.2 rejects component-wise edge deltas <=1e-4 even on a
            # manifold voxel mesh, and still returns FINISHED on that rejection.
            bm=bmesh.new();bm.from_mesh(low.data)
            short=[e for e in bm.edges if max(abs(x) for x in e.verts[0].co-e.verts[1].co)<=.00011]
            if short:bmesh.ops.collapse(bm,edges=short,uvs=False)
            bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces));bm.to_mesh(low.data);bm.free();low.data.update()
            before=topology_signature(low.data)
            try:
                result=bpy.ops.object.quadriflow_remesh(target_faces=max(100,target//2),use_mesh_symmetry=False,use_preserve_sharp=True,use_preserve_boundary=True)
                if 'FINISHED' not in result or topology_signature(low.data)==before:raise RuntimeError('QuadriFlow 未生成新拓扑')
            except RuntimeError as e:
                raise RuntimeError('自动重拓扑失败，请转人工处理：'+str(e)) from e
            print('QuadriFlow 已实际生成新拓扑',flush=True)
            tris=sum(len(p.vertices)-2 for p in low.data.polygons)
            if tris>target:
                dec=low.modifiers.new('FinalBudget','DECIMATE');dec.ratio=target/max(tris,1)*.98;dec.use_collapse_triangulate=True;bpy.ops.object.modifier_apply(modifier=dec.name)
            # Finish all topology changes before UV layout and baking.
            clean_surface(low)
            count=sum(len(p.vertices)-2 for p in low.data.polygons)
            if count>target:
                dec=low.modifiers.new('RepairBudget','DECIMATE');dec.ratio=target/count*.98;dec.use_collapse_triangulate=True
                bpy.ops.object.modifier_apply(modifier=dec.name);clean_surface(low)
            if sum(len(p.vertices)-2 for p in low.data.polygons)>target:raise ValueError('修复后的面数仍超预算，需要人工重拓扑')
            print('阶段 3/5：重新展开 UV',flush=True)
            activate(low);bpy.ops.object.mode_set(mode='EDIT');bpy.ops.mesh.select_all(action='SELECT');bpy.ops.uv.smart_project(angle_limit=math.radians(66),island_margin=.015);bpy.ops.object.mode_set(mode='OBJECT')
            print('阶段 4/5：CPU PBR 烘焙',flush=True)
            bake(high,low,int(request['preset']['tex']))
            bpy.data.objects.remove(high,do_unlink=True)
        activate(low)
        if operation=='fix':clean_surface(low)
        bpy.ops.object.origin_set(type='ORIGIN_GEOMETRY',center='BOUNDS')
        zmin=min((low.matrix_world@v.co).z for v in low.data.vertices)
        bpy.context.scene.cursor.location=(low.location.x,low.location.y,zmin);bpy.ops.object.origin_set(type='ORIGIN_CURSOR');low.location=(0,0,0)
    if operation != 'qa':
        if operation=='optimize':print('阶段 5/5：保存 GLB 与 Blender 工程',flush=True)
        bpy.ops.wm.save_as_mainfile(filepath=request['blend'])
        bpy.ops.export_scene.gltf(filepath=request['output'],export_format='GLB',export_extras=True,export_tangents=True)
        stamp(request['output'],request.get('mark'))
        path=Path(request['output'])
    else:path=source
    stat=measure(objects(),path)
    preset=request['preset'];items=[]
    def item(rule,name,value,limit,ok,level='阻断'):
        items.append(dict(rule=rule,name=name,measured=value,limit=limit,level=level,result='pass' if ok else 'warn' if level=='警告' else 'fail'))
    item('Q01','三角形数',stat['tris'],target,stat['tris']<=target)
    item('Q02','贴图分辨率',stat['texture'],preset['tex'],0<stat['texture']<=preset['tex'])
    item('Q03','材质数',stat['materials'],preset['materials'],stat['materials']<=preset['materials'])
    item('Q04','非流形边',stat['nonmanifold'],0,stat['nonmanifold']==0,'可修复')
    item('Q05','UV 重叠率',str(stat['uvOverlap'])+'%', '≤1% 且有 UV',not stat['missing_uv'] and stat['uvOverlap']<=1,'警告')
    item('Q06','法线翻转或不一致',stat['flipped'],0,stat['flipped']==0,'可修复')
    size=stat['size_m'];origin=stat['origin_offset_m']
    item('Q07','尺寸与原点',str(size)+' m; 原点偏移 '+str(origin)+'m','最大尺寸 0.1–3m; 底部中心偏移≤0.005m',.1<=max(size)<=3 and origin<=.005,'可修复')
    actual=glb_json(path).get('asset',{}).get('extras',{}).get('AIGC')
    expected=request.get('mark')
    mark_valid=bool(actual and expected and all(actual.get(k)==expected.get(k) for k in ['model','seed','time','generated','label']))
    result=dict(stats=stat,items=items,mark_valid=mark_valid,sha256=hashlib.sha256(path.read_bytes()).hexdigest(),seconds=round(time.monotonic()-started,3))
    Path(request['report']).write_text(json.dumps(result,ensure_ascii=False,indent=2),'utf-8')
    print(json.dumps(result,ensure_ascii=False),flush=True)


if __name__=='__main__':
    try: main(json.loads(Path(sys.argv[1]).read_text('utf-8')))
    except Exception:
        import traceback;traceback.print_exc();sys.stdout.flush();sys.stderr.flush();os._exit(1)
    sys.stdout.flush();sys.stderr.flush();os._exit(0)
