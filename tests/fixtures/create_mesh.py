"""Deterministic textured high mesh for CPU integration testing, not an AI sample."""
import bpy,os,sys
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_uv_sphere_add(segments=96,ring_count=64,radius=.5,location=(.2,0,.5))
obj=bpy.context.object
mat=bpy.data.materials.new('fixture');mat.use_nodes=True
img=bpy.data.images.new('fixtureTexture',width=256,height=256)
img.generated_type='COLOR_GRID';img.pack()
node=mat.node_tree.nodes.new('ShaderNodeTexImage');node.image=img
mat.node_tree.links.new(node.outputs['Color'],mat.node_tree.nodes.get('Principled BSDF').inputs['Base Color'])
obj.data.materials.append(mat)
bpy.ops.export_scene.gltf(filepath=sys.argv[1],export_format='GLB')
sys.stdout.flush();sys.stderr.flush();os._exit(0)
