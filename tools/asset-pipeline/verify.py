"""Validate actual demo GLB buffers, textures, receipts and full video decode."""
import argparse
import hashlib
import json
import math
import struct
import subprocess
from pathlib import Path

import imageio_ffmpeg
from PIL import Image

def verify(out):
    manifest = json.loads((out / 'manifest.json').read_text(encoding='utf-8'))
    for name, expected in manifest['files'].items():
        p = (out / name).resolve()
        if not p.is_relative_to(out.resolve()) or hashlib.sha256(p.read_bytes()).hexdigest() != expected:
            raise ValueError('File/hash mismatch: ' + name)
    for name in ['source.blend', 'asset.glb', 'preview.png', 'showcase.mp4']:
        if name not in manifest['files']:
            raise ValueError('Missing required output: ' + name)
    for p in [out / 'preview.png', *sorted((out / 'textures').glob('*.png'))]:
        with Image.open(p) as image:
            image.verify()
    data = (out / 'asset.glb').read_bytes()
    magic, version, size = struct.unpack_from('<4sII', data)
    if (magic, version, size) != (b'glTF', 2, len(data)):
        raise ValueError('Invalid GLB header')
    json_size, kind = struct.unpack_from('<I4s', data, 12)
    if kind != b'JSON':
        raise ValueError('Missing GLB JSON')
    gltf = json.loads(data[20:20+json_size])
    binary_size, binary_kind = struct.unpack_from('<I4s', data, 20+json_size)
    if binary_kind != b'BIN\0':
        raise ValueError('Missing GLB binary')
    binary = data[28+json_size:28+json_size+binary_size]
    triangles = 0
    for mesh in gltf['meshes']:
        for primitive in mesh['primitives']:
            attributes = primitive['attributes']
            for key in ['POSITION', 'NORMAL', 'TEXCOORD_0', 'TEXCOORD_1']:
                if key not in attributes:
                    raise ValueError('Missing GLB attribute: ' + key)
            accessor = gltf['accessors'][attributes['TEXCOORD_1']]
            if accessor['componentType'] != 5126 or accessor['type'] != 'VEC2':
                raise ValueError('Unexpected UV2 encoding')
            view = gltf['bufferViews'][accessor['bufferView']]
            offset = view.get('byteOffset', 0) + accessor.get('byteOffset', 0)
            stride = view.get('byteStride', 8)
            for i in range(accessor['count']):
                values = struct.unpack_from('<ff', binary, offset + i * stride)
                if not all(math.isfinite(v) and 0 <= v <= 1 for v in values):
                    raise ValueError('Invalid UV2 coordinates')
            triangles += gltf['accessors'][primitive['indices']]['count'] // 3
    if triangles != manifest['triangles']:
        raise ValueError('Exported triangle count mismatch')
    subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-v', 'error', '-xerror', '-i',
                    str(out / 'showcase.mp4'), '-f', 'null', '-'], check=True, capture_output=True)
    result = {'passed': True, 'triangles': triangles, 'uv2PresentAndBounded': True,
              'videoFullDecode': True, 'projectImportAccepted': False, 'receiverAccepted': False,
              'note': 'UV2 presence/bounds do not prove overlap, density or actual receiver coverage.'}
    (out / 'verification.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps(result))
    return result

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', required=True, type=Path)
    verify(parser.parse_args().out)
