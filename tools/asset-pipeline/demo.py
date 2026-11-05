"""Reproducible starter prop; replace the model recipe for production assets.
Blender imports this only with --python-use-system-env and the managed venv.
"""
import argparse
import hashlib
import json
import math
import os
import subprocess
import sys
from pathlib import Path

import bpy
import imageio_ffmpeg
import numpy as np
from mathutils import Vector
from PIL import Image

parser = argparse.ArgumentParser()
parser.add_argument('--out', required=True, type=Path)
parser.add_argument('--frames', type=int, default=48)
args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])
if not 2 <= args.frames <= 240:
    raise ValueError('frames must be 2..240')
out = args.out.resolve()
(out / 'textures').mkdir()
(out / 'frames').mkdir()
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)

# Independent parameter sources. Flat normal and constant channels are intentional
# for this simple demo, not a replacement for authored production PBR detail.
rng = np.random.default_rng(42)
noise = rng.integers(-12, 13, (256, 256, 1))
color = np.clip(np.array([162, 143, 109])[None, None, :] + noise, 0, 255).astype('uint8')
images = {'albedo': color, 'normal': np.full((256, 256, 3), [128, 128, 255], dtype='uint8'),
          'roughness': np.full((256, 256), 190, dtype='uint8'),
          'metallic': np.zeros((256, 256), dtype='uint8'), 'ao': np.full((256, 256), 255, dtype='uint8')}
for name, pixels in images.items():
    Image.fromarray(pixels).save(out / 'textures' / (name + '.png'))

bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0.9))
obj = bpy.context.object
obj.name = 'StarterStonePillar'
obj.dimensions = (0.8, 0.8, 1.8)
bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
bevel = obj.modifiers.new('AuthoredEdgeBevel', 'BEVEL')
bevel.width = 0.045
bevel.segments = 2
bpy.ops.object.modifier_apply(modifier=bevel.name)
tri = obj.modifiers.new('DeterministicTriangles', 'TRIANGULATE')
bpy.ops.object.modifier_apply(modifier=tri.name)
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.uv.smart_project(island_margin=0.03)
bpy.ops.object.mode_set(mode='OBJECT')
obj.data.uv_layers[0].name = 'UVMap'
positions = np.asarray([v.co[:] for v in obj.data.vertices], dtype=np.float32)
faces = np.asarray([p.vertices[:] for p in obj.data.polygons], dtype=np.uint32)
# Keep xatlas in its own process: loading its native runtime inside Blender can
# collide with Blender's Windows MSVC/OpenMP libraries.
unwrap_input = out / 'unwrap-input.json'
unwrap_output = out / 'unwrap-output.json'
unwrap_input.write_text(json.dumps({'positions': positions.tolist(), 'faces': faces.tolist()}))
subprocess.run([os.environ['PYTHON_EXE'], str(Path(__file__).with_name('unwrap.py')),
                str(unwrap_input), str(unwrap_output)], check=True)
unwrapped = json.loads(unwrap_output.read_text())
indices, uv = unwrapped['indices'], unwrapped['uv']
uv2 = obj.data.uv_layers.new(name='UV2')
for poly, tex_indices in zip(obj.data.polygons, indices):
    for loop, index in zip(poly.loop_indices, tex_indices):
        uv2.data[loop].uv = uv[index]
obj.data.uv_layers.active_index = 0

mat = bpy.data.materials.new('DemoStone')
mat.use_nodes = True
nodes = mat.node_tree.nodes
links = mat.node_tree.links
bsdf = nodes.get('Principled BSDF')
for name, socket in [('albedo', 'Base Color'), ('roughness', 'Roughness'), ('metallic', 'Metallic')]:
    node = nodes.new('ShaderNodeTexImage')
    node.image = bpy.data.images.load(str(out / 'textures' / (name + '.png')))
    node.image.colorspace_settings.name = 'sRGB' if name == 'albedo' else 'Non-Color'
    links.new(node.outputs['Color'], bsdf.inputs[socket])
normal_tex = nodes.new('ShaderNodeTexImage')
normal_tex.image = bpy.data.images.load(str(out / 'textures/normal.png'))
normal_tex.image.colorspace_settings.name = 'Non-Color'
normal = nodes.new('ShaderNodeNormalMap')
links.new(normal_tex.outputs['Color'], normal.inputs['Color'])
links.new(normal.outputs['Normal'], bsdf.inputs['Normal'])
obj.data.materials.append(mat)
obj.select_set(True)
bpy.context.view_layer.objects.active = obj
bpy.ops.export_scene.gltf(filepath=str(out / 'asset.glb'), export_format='GLB', use_selection=True,
                          export_texcoords=True, export_normals=True, export_materials='EXPORT')

def aim(ob, target):
    ob.rotation_euler = (Vector(target) - ob.location).to_track_quat('-Z', 'Y').to_euler()

bpy.ops.object.camera_add(location=(3.1, -4, 2.7))
camera = bpy.context.object
camera.data.lens = 52
aim(camera, (0, 0, 0.9))
scene = bpy.context.scene
scene.camera = camera
for location, power, size in [((2, -3, 4), 650, 4), ((-3, -1, 2), 350, 3), ((1, 3, 3), 850, 2)]:
    bpy.ops.object.light_add(type='AREA', location=location)
    light = bpy.context.object
    light.data.energy = power
    light.data.shape = 'DISK'
    light.data.size = size
    aim(light, (0, 0, 0.8))
scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.cycles.samples = 8
scene.render.resolution_x = scene.render.resolution_y = 384
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.fps = 24
scene.world.color = (0.15, 0.15, 0.15)
scene.render.filepath = str(out / 'preview.png')
bpy.ops.file.pack_all()
bpy.ops.wm.save_as_mainfile(filepath=str(out / 'source.blend'))
bpy.ops.render.render(write_still=True)
for frame in range(args.frames):
    angle = 2 * math.pi * frame / args.frames
    camera.location = (4 * math.sin(angle), -4 * math.cos(angle), 2.6)
    aim(camera, (0, 0, 0.9))
    scene.render.filepath = str(out / 'frames' / ('%04d.png' % frame))
    bpy.ops.render.render(write_still=True)

# FFmpeg is delivered by the pinned wheel; MP4 faststart/AVC/yuv420p for Safari.
subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-v', 'error', '-n', '-framerate', '24',
                '-i', str(out / 'frames/%04d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
                '-movflags', '+faststart', str(out / 'showcase.mp4')], check=True)
files = [p for p in out.rglob('*') if p.is_file() and 'frames' not in p.parts and p.suffix != '.log']
manifest = {'schema': 'agent-relay.asset-demo/1', 'asset': obj.name, 'meters': [0.8, 0.8, 1.8],
            'triangles': len(obj.data.polygons), 'videoFrames': args.frames, 'fps': 24,
            'uv2': {'method': 'xatlas', 'resolution': 512, 'padding': 8, 'receiverAccepted': False},
            'materials': {'albedo': 'sRGB', 'normal': 'linear, OpenGL +Y, intentionally flat',
                          'roughness': 'linear', 'metallic': 'linear, dielectric zero', 'ao': 'linear, white neutral'},
            'files': {p.relative_to(out).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in files},
            'acceptance': 'Starter DCC asset, not approved art or engine receiver/gameplay acceptance'}
(out / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
print('ASSET_OUTPUT=' + str(out))
