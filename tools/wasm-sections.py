#!/usr/bin/env python3
# Minimal wasm import/export section reader (no compilation).
import sys, struct

def uleb(b, i):
    r = 0; s = 0
    while True:
        x = b[i]; i += 1
        r |= (x & 0x7f) << s
        if not (x & 0x80): return r, i
        s += 7

def name(b, i):
    n, i = uleb(b, i)
    return b[i:i+n].decode('utf-8', 'replace'), i+n

def main(path):
    b = open(path, 'rb').read()
    assert b[:4] == b'\x00asm', 'not wasm'
    i = 8
    imports = []
    exports = []
    while i < len(b):
        sid = b[i]; i += 1
        size, i = uleb(b, i)
        end = i + size
        if sid == 2:  # import section
            cnt, j = uleb(b, i)
            for _ in range(cnt):
                mod, j = name(b, j)
                nm, j = name(b, j)
                kind = b[j]; j += 1
                if kind == 0: _, j = uleb(b, j)
                elif kind == 1:
                    j += 1; _, j = uleb(b, j); _, j = uleb(b, j)
                elif kind == 2:
                    flags = b[j]; j += 1; _, j = uleb(b, j)
                    if flags & 1: _, j = uleb(b, j)
                elif kind == 3: j += 2
                imports.append((mod, nm, kind))
        elif sid == 7:  # export section
            cnt, j = uleb(b, i)
            for _ in range(cnt):
                nm, j = name(b, j)
                kind = b[j]; j += 1
                _, j = uleb(b, j)
                exports.append((nm, kind))
        i = end
    jit_imports = [x for x in imports if 'jit' in x[1] or 'aot' in x[1]]
    jit_exports = [x for x in exports if 'jit' in x[0] or 'aot' in x[0]]
    print(f"{path}: {len(b)} bytes, {len(imports)} imports, {len(exports)} exports")
    print("  jit/aot imports:", jit_imports[:20])
    print("  jit/aot exports:", jit_exports[:40])
    print("  wasi import modules:", sorted(set(m for m,_,_ in imports))[:5])

for p in sys.argv[1:]:
    main(p)
