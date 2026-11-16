"""Deterministic textured high mesh for CPU integration testing, not an AI sample."""
import bpy,os,sys
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_uv_sphere_add(segments=96,ring_count=64,radius=.5,location=(.2,0,.5))
obj=bpy.context.object
if '--open-sheet' in sys.argv:
 import bmesh
 bm=bmesh.new();bm.from_mesh(obj.data);bm.faces.ensure_lookup_table()
 bmesh.ops.delete(bm,geom=[bm.faces[0]],context='FACES');bm.to_mesh(obj.data);bm.free()
if '--open-fragment' in sys.argv:
 import bmesh
 bm=bmesh.new();bm.from_mesh(obj.data)
 vs=[bm.verts.new(co) for co in [(1.2,0,0),(1.21,0,0),(1.2,.01,0)]]
 bm.faces.new(vs);bm.to_mesh(obj.data);bm.free()
mat=bpy.data.materials.new('fixture');mat.use_nodes=True
img=bpy.data.images.new('fixtureTexture',width=256,height=256)
img.generated_type='COLOR_GRID';img.pack()
node=mat.node_tree.nodes.new('ShaderNodeTexImage');node.image=img
mat.node_tree.links.new(node.outputs['Color'],mat.node_tree.nodes.get('Principled BSDF').inputs['Base Color'])
obj.data.materials.append(mat)
bpy.ops.export_scene.gltf(filepath=sys.argv[1],export_format='GLB')
sys.stdout.flush();sys.stderr.flush();os._exit(0)
