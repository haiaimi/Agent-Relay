"""xatlas worker runs outside Blender to isolate native DLLs. Triangles in JSON."""
import json
import sys
from pathlib import Path
import numpy as np
import xatlas

mesh = json.loads(Path(sys.argv[1]).read_text())
atlas = xatlas.Atlas()
atlas.add_mesh(np.asarray(mesh['positions'], dtype=np.float32), np.asarray(mesh['faces'], dtype=np.uint32))
pack = xatlas.PackOptions()
pack.resolution = 512
pack.padding = 8
atlas.generate(pack_options=pack)
mapping, indices, uv = atlas[0]
Path(sys.argv[2]).write_text(json.dumps({'mapping': mapping.tolist(), 'indices': indices.tolist(), 'uv': uv.tolist()}))
