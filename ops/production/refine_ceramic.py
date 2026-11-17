"""Reproducible ceramic art refinement, explicitly distinct from raw AI inference.

Uses the generated vase's measured radial profile as the silhouette reference.
Builds a hollow rotational shell and authored glaze PBR textures; never copies Bee.
Run with the Blender Python environment: refine_ceramic.py OUTPUT_DIR [--render].
"""
import argparse
import json
import math
import os
from pathlib import Path
import sys

import bpy
import numpy as np
from mathutils import Vector


def catmull(points, samples=199):
    p=np.array(points,dtype=float)
    length=np.r_[0,np.cumsum(np.linalg.norm(np.diff(p,axis=0),axis=1))]
    ts=np.linspace(0,length[-1],samples)
    result=[]
    for t in ts:
        i=min(len(p)-2,max(0,np.searchsorted(length,t,side='right')-1))
        u=(t-length[i])/(length[i+1]-length[i])
        a,b,c,d=p[max(0,i-1)],p[i],p[i+1],p[min(len(p)-1,i+2)]
        result.append(.5*((2*b)+(-a+c)*u+(2*a-5*b+4*c-d)*u*u+(-a+3*b-3*c+d)*u**3))
    result=np.array(result);result[:,0]=np.maximum(result[:,0],0)
    result[0]=p[0];result[-1]=p[-1]
    return result


def image(name, rgb, path, linear=False):
    h,w=rgb.shape[:2];im=bpy.data.images.new(name,width=w,height=h,alpha=False)
    im.colorspace_settings.name='Non-Color' if linear else 'sRGB'
    rgba=np.ones((h,w,4),np.float32);rgba[:,:,:3]=rgb
    im.pixels.foreach_set(rgba.ravel());im.filepath_raw=str(path);im.file_format='PNG';im.save()
    # Render from the same serialized PNG bytes that the GLB exporter embeds.
    loaded=bpy.data.images.load(str(path),check_existing=False)
    loaded.colorspace_settings.name='Non-Color' if linear else 'sRGB';loaded.pack()
    return loaded


def main(out, render):
    out.mkdir(parents=True,exist_ok=True);(out/'textures').mkdir(exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    # Outer samples correspond to radial percentiles measured from raw TRELLIS GLB.
    outer=[(.262,.02),(.300,.06),(.348,.10),(.381,.14),(.407,.18),(.425,.22),(.438,.26),(.445,.30),(.450,.34),(.451,.38),(.449,.42),(.443,.46),(.431,.50),(.415,.54),(.393,.58),(.366,.62),(.326,.66),(.276,.70),(.219,.74),(.169,.78),(.137,.82),(.124,.86),(.120,.90),(.148,.94),(.188,.98)]
    # Closed bottom, defined foot, rounded lip, descending inner wall and inner floor.
    path=[(0,.003),(.16,.003),(.238,.003),(.252,.008)]+outer+[(.191,.989),(.189,.996),(.182,1.0),(.174,.996),(.171,.987)]
    path += [(max(.01,r-.018),z) for r,z in reversed(outer[:-1]) if z>=.10]
    path += [(.30,.082),(.24,.055),(.15,.046),(0,.046)]
    profile=catmull(path);rings=profile[1:-1];segments=128;scale=.30
    verts=[(0,0,profile[0,1]*scale)]
    for radius,z in rings:
        for j in range(segments):
            a=2*math.pi*j/segments;verts.append((radius*math.cos(a)*scale,radius*math.sin(a)*scale,z*scale))
    end=len(verts);verts.append((0,0,profile[-1,1]*scale))
    faces=[];uvs=[];n=len(profile)
    for j in range(segments):
        k=(j+1)%segments
        faces.append((0,1+k,1+j));uvs.append(((j+.5)/segments,0,(j+1)/segments,1/(n-1),j/segments,1/(n-1)))
    for i in range(len(rings)-1):
        for j in range(segments):
            k=(j+1)%segments;a=1+i*segments;b=a+segments
            faces.append((a+j,a+k,b+k,b+j));uvs.append((j/segments,(i+1)/(n-1),(j+1)/segments,(i+1)/(n-1),(j+1)/segments,(i+2)/(n-1),j/segments,(i+2)/(n-1)))
    base=1+(len(rings)-1)*segments
    for j in range(segments):
        faces.append((base+j,base+(j+1)%segments,end));uvs.append((j/segments,(n-2)/(n-1),(j+1)/segments,(n-2)/(n-1),(j+.5)/segments,1))
    mesh=bpy.data.meshes.new('HollowCeramicShell');mesh.from_pydata(verts,[],faces);mesh.update()
    obj=bpy.data.objects.new('BlueGlazeVase_Hero',mesh);bpy.context.collection.objects.link(obj)
    bpy.context.view_layer.objects.active=obj;obj.select_set(True)
    uv=mesh.uv_layers.new(name='CeramicUV')
    for p,coords in zip(mesh.polygons,uvs):
        p.use_smooth=True
        for k,li in enumerate(p.loop_indices):uv.data[li].uv=coords[k*2:k*2+2]
    import bmesh
    bm=bmesh.new();bm.from_mesh(mesh);bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces));bm.to_mesh(mesh);bm.free()
    size=2048;v=np.linspace(0,1,size,endpoint=False,dtype=np.float32)[:,None];u=np.linspace(0,1,size,endpoint=False,dtype=np.float32)[None,:]
    z=np.interp(v[:,0],np.linspace(0,1,n),profile[:,1])[:,None]
    variation=.018*np.sin(u*2*np.pi*19+v*113)+.01*np.sin(u*2*np.pi*53-v*237)
    blue=np.array([.16,.38,.58],np.float32)
    color=np.clip(blue[None,None,:]*(1+variation[:,:,None]),0,1)
    rim=np.clip((z-.974)/.016,0,1)[:,:,None]
    color=color*(1-rim)+np.array([.78,.82,.79])[None,None,:]*rim
    foot=np.clip((.019-z)/.01,0,1)[:,:,None];color=color*(1-foot)+np.array([.39,.30,.19])[None,None,:]*foot
    rough=np.broadcast_to(np.clip(.20+variation*.9+foot[:,:,0]*.32,.14,.6),(size,size))
    # Mild tangent-space microstructure, authored procedural glaze rather than baked lighting.
    nx=.003*np.sin(u*2*np.pi*79+v*181);ny=.003*np.cos(u*2*np.pi*37-v*337)
    normal=np.stack((nx*.5+.5,ny*.5+.5,np.sqrt(1-nx*nx-ny*ny)*.5+.5),axis=2)
    ims={
        'BaseColor':image('Ceramic_BaseColor_2K',color,out/'textures/basecolor.png'),
        'Roughness':image('Ceramic_Roughness_2K',np.repeat(rough[:,:,None],3,axis=2),out/'textures/roughness.png',True),
        'Normal':image('Ceramic_Normal_2K',normal,out/'textures/normal.png',True),
    }
    mat=bpy.data.materials.new('BlueCeramicGlaze');mat.use_nodes=True;mesh.materials.append(mat)
    tree=mat.node_tree;pbr=tree.nodes.get('Principled BSDF')
    pbr.inputs['Metallic'].default_value=0;pbr.inputs['Roughness'].default_value=.2;pbr.inputs['IOR'].default_value=1.48
    pbr.inputs['Coat Weight'].default_value=.55;pbr.inputs['Coat Roughness'].default_value=.12
    for key,im in ims.items():
        node=tree.nodes.new('ShaderNodeTexImage');node.image=im
        if key=='Normal':
            nm=tree.nodes.new('ShaderNodeNormalMap');tree.links.new(node.outputs['Color'],nm.inputs['Color']);tree.links.new(nm.outputs['Normal'],pbr.inputs['Normal'])
        else:tree.links.new(node.outputs['Color'],pbr.inputs['Base Color' if key=='BaseColor' else 'Roughness'])
    scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.device='CPU';scene.cycles.samples=16
    scene.render.threads_mode='FIXED';scene.render.threads=8
    # Bake real geometric cavity occlusion; exported as the standard glTF AO channel.
    ao=bpy.data.images.new('Ceramic_AO_1K',width=1024,height=1024,alpha=False);ao.colorspace_settings.name='Non-Color'
    node=tree.nodes.new('ShaderNodeTexImage');node.image=ao;tree.nodes.active=node
    bpy.ops.object.bake(type='AO',margin=8)
    ao.filepath_raw=str(out/'textures/ao.png');ao.file_format='PNG';ao.save();ao.pack()
    group=bpy.data.node_groups.new('glTF Material Output','ShaderNodeTree');group.interface.new_socket(name='Occlusion',in_out='INPUT',socket_type='NodeSocketFloat')
    gn=tree.nodes.new('ShaderNodeGroup');gn.node_tree=group;tree.links.new(node.outputs['Color'],gn.inputs['Occlusion'])
    provenance={'label':'AI 参考 · 程序化精修','generated':True,'model':'Qwen-Image + TRELLIS.2 silhouette + procedural ceramic refinement','reference_asset':'SC-134 raw','refinement':'hollow lathe geometry, authored glaze, real AO bake','display_height_m':.30,'dimensions_measured':False,'time':'2026-11-17'}
    bpy.ops.export_scene.gltf(filepath=str(out/'蓝釉花瓶_精细展示.glb'),export_format='GLB',export_tangents=True,export_extras=True)
    sys.path.insert(0,str(Path(__file__).resolve().parent));from mesh_pipeline import stamp,measure
    stamp(out/'蓝釉花瓶_精细展示.glb',provenance)
    stats=measure([obj],out/'蓝釉花瓶_精细展示.glb')
    (out/'quality.json').write_text(json.dumps({'provenance':provenance,'stats':stats,'texture_sizes':{'basecolor':2048,'roughness':2048,'normal':2048,'AO':1024},'reference_profile':outer},ensure_ascii=False,indent=2),'utf-8')
    # Studio lighting remains scene lighting and never becomes paint on the asset.
    world=bpy.data.worlds.new('Studio');world.use_nodes=True;scene.world=world
    env=world.node_tree.nodes.new('ShaderNodeTexEnvironment');env.image=bpy.data.images.load('/opt/scw/TRELLIS.2/assets/hdri/studio.exr')
    world.node_tree.links.new(env.outputs['Color'],world.node_tree.nodes.get('Background').inputs['Color']);world.node_tree.nodes.get('Background').inputs['Strength'].default_value=.3
    treew=world.node_tree;lighting=treew.nodes.get('Background');camera_bg=treew.nodes.new('ShaderNodeBackground');camera_bg.inputs['Color'].default_value=(.14,.16,.18,1)
    lightpath=treew.nodes.new('ShaderNodeLightPath');mix=treew.nodes.new('ShaderNodeMixShader')
    treew.links.new(lightpath.outputs['Is Camera Ray'],mix.inputs[0]);treew.links.new(lighting.outputs[0],mix.inputs[1]);treew.links.new(camera_bg.outputs[0],mix.inputs[2]);treew.links.new(mix.outputs[0],treew.nodes.get('World Output').inputs['Surface'])
    def area(name,loc,power,shape,size,size_y):
        light=bpy.data.lights.new(name,'AREA');light.energy=power;light.shape=shape;light.size=size;light.size_y=size_y
        o=bpy.data.objects.new(name,light);bpy.context.collection.objects.link(o);o.location=loc;o.rotation_euler=(Vector((0,0,.15))-o.location).to_track_quat('-Z','Y').to_euler()
    area('KeySoftbox',(.5,-.6,.65),35,'RECTANGLE',.2,.7)
    area('RimSoftbox',(-.45,.25,.5),25,'RECTANGLE',.15,.55)
    area('Fill',(.1,.5,.65),12,'DISK',.4,.4)
    bpy.ops.mesh.primitive_plane_add(size=200,location=(0,0,-.0005));floor=bpy.context.object;floor.name='RenderBackdrop'
    fm=bpy.data.materials.new('WarmGray');fm.diffuse_color=(.16,.18,.19,1);floor.data.materials.append(fm)
    bpy.ops.object.camera_add();cam=bpy.context.object;cam.data.lens=65;scene.camera=cam
    scene.render.resolution_x=1100;scene.render.resolution_y=1100;scene.render.resolution_percentage=100
    scene.view_settings.view_transform='AgX';scene.cycles.samples=32;scene.cycles.use_denoising=True
    cam.location=(.48,-.78,.43);cam.rotation_euler=(Vector((0,0,.15))-cam.location).to_track_quat('-Z','Y').to_euler()
    for o in bpy.context.selected_objects:o.select_set(False)
    obj.select_set(True);bpy.context.view_layer.objects.active=obj
    bpy.ops.wm.save_as_mainfile(filepath=str(out/'蓝釉花瓶_精细展示.blend'))
    if render:
        for name,pos in [('正面',(.48,-.78,.43)),('侧面',(-.72,-.45,.43)),('俯视瓶口',(.42,-.55,.69))]:
            cam.location=pos;cam.rotation_euler=(Vector((0,0,.15))-cam.location).to_track_quat('-Z','Y').to_euler()
            scene.render.filepath=str(out/(name+'.png'));bpy.ops.render.render(write_still=True)
    print(json.dumps(stats,ensure_ascii=False),flush=True)


if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('output');ap.add_argument('--render',action='store_true');a=ap.parse_args()
    try:main(Path(a.output).resolve(),a.render)
    except Exception:
        import traceback;traceback.print_exc();sys.stdout.flush();sys.stderr.flush();os._exit(1)
    sys.stdout.flush();sys.stderr.flush();os._exit(0)
