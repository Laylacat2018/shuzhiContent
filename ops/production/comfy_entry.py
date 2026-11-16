"""ComfyUI launcher with a narrow PyTorch 2.6/Python 3.10 annotation compatibility shim.

torch 2.6 infer_schema accepts typing.List[int] but rejects the equivalent list[int]
used by current comfy-kitchen. This changes annotations only, never tensor operations.
"""
import os
import importlib.abc
import importlib.machinery
from pathlib import Path
import runpy
import sys
import types
import typing

def legacy_annotation(t):
    origin=typing.get_origin(t);args=typing.get_args(t)
    if origin is list:return typing.List[legacy_annotation(args[0])]
    if origin is types.UnionType:return typing.Union[tuple(legacy_annotation(a) for a in args)]
    return t


class TorchCompatibility(importlib.abc.MetaPathFinder):
    """Apply after torch loads naturally, after Comfy configures its allocator."""
    def find_spec(self, fullname, path=None, target=None):
        if fullname != 'torch': return None
        spec=importlib.machinery.PathFinder.find_spec(fullname,path)
        if not spec or not spec.loader: return None
        loader=spec.loader
        class Loader(importlib.abc.Loader):
            def create_module(self, spec): return loader.create_module(spec)
            def exec_module(self, module):
                loader.exec_module(module)
                if module.__version__.split('+')[0].startswith('2.6.'):
                    original=module.library.infer_schema
                    def infer_schema(function, *args, **kwargs):
                        if function.__module__.startswith('comfy_kitchen'):
                            function.__annotations__={name:(None if name=='return' and value is type(None) else legacy_annotation(value)) for name,value in typing.get_type_hints(function).items()}
                        return original(function,*args,**kwargs)
                    module.library.infer_schema=infer_schema
        spec.loader=Loader()
        return spec


sys.meta_path.insert(0,TorchCompatibility())

if '--probe' in sys.argv:
    import torch
    import comfy_kitchen
    print('Comfy kitchen registered successfully; PyTorch '+torch.__version__)
else:
    root=Path(os.getenv('SCW_COMFY_HOME','/opt/scw/ComfyUI'))
    os.chdir(root);sys.path.insert(0,str(root));sys.argv[0]=str(root/'main.py')
    runpy.run_path(str(root/'main.py'),run_name='__main__')
