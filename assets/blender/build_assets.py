"""Riftline 3D 애셋 빌더 — Blender 5.2 헤드리스에서 모든 GLB 를 절차적으로 만든다.

실행(보통은 `npm run build:assets` 가 대신 실행):
  blender -b --factory-startup --python-exit-code 1 --python assets/blender/build_assets.py -- \
      --out assets/models [--previews assets/previews] [--only heroes,weapons,map,props]

규격은 docs/ASSETS.md. Blender 좌표 (X, Y, Z) = 게임 좌표 (x, -z, y).
캐릭터·무기는 Blender +Y(게임 -Z)를 바라보고, 오른손은 +X 쪽이다.
"""
import argparse
import json
import math
import os
import sys
import tempfile
import time

import bmesh
import bpy
import numpy as np
from mathutils import Euler, Matrix, Vector

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MAP_JSON = os.path.join(ROOT, 'shared', 'map-data.json')

# shared/heroes.js 와 같은 값을 유지한다(tools/check-assets.mjs 가 높이·색을 대조한다).
HEROES = {
    'kodiak': {'height': 2.1, 'radius': 0.55, 'primary': '#5b6470', 'accent': '#e8892c'},
    'vex': {'height': 1.8, 'radius': 0.4, 'primary': '#e9edf2', 'accent': '#2fd6c8'},
    'ember': {'height': 1.85, 'radius': 0.42, 'primary': '#7a2a24', 'accent': '#ff9a2e'},
    'rook': {'height': 1.8, 'radius': 0.4, 'primary': '#3d4a33', 'accent': '#b7f04a'},
    'sol': {'height': 1.8, 'radius': 0.4, 'primary': '#f1ede2', 'accent': '#f2c53d'},
}
TEAM_COLORS = ['#3aa0ff', '#ff4d4d']  # shared/constants.js TEAM_COLORS

TEX_DIR = tempfile.mkdtemp(prefix='riftline_tex_')


# ─────────────────────────────────────────────────────────────
# 공통 유틸
# ─────────────────────────────────────────────────────────────
def log(*a):
    print('[assets]', *a, flush=True)


def hex_rgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))


def srgb_to_lin(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def lin(color):
    rgb = hex_rgb(color) if isinstance(color, str) else color
    return tuple(srgb_to_lin(c) for c in rgb)


def link(obj):
    bpy.context.scene.collection.objects.link(obj)
    return obj


def reset():
    """씬과 데이터 블록을 비워 다음 애셋의 이름(머티리얼 .001 등)이 충돌하지 않게 한다."""
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.curves, bpy.data.cameras, bpy.data.lights):
        for item in list(coll):
            coll.remove(item)
    for img in list(bpy.data.images):
        if img.type == 'IMAGE':
            bpy.data.images.remove(img)


def make_mat(name, color, metallic=0.0, roughness=0.6, emission=None, strength=1.0,
             image=None, emission_image=False, double=False):
    m = bpy.data.materials.new(name)
    if m.node_tree is None:   # Blender 5.x 는 새 머티리얼에 노드 트리가 이미 있다(use_nodes 는 6.0 에서 제거 예정)
        m.use_nodes = True
    nt = m.node_tree
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    bsdf.inputs['Base Color'].default_value = (*lin(color), 1.0)
    bsdf.inputs['Metallic'].default_value = metallic
    bsdf.inputs['Roughness'].default_value = roughness
    if image is not None:
        tex = nt.nodes.new('ShaderNodeTexImage')
        tex.image = image
        nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
        if emission_image:
            nt.links.new(tex.outputs['Color'], bsdf.inputs['Emission Color'])
            bsdf.inputs['Emission Strength'].default_value = strength
    if emission is not None:
        bsdf.inputs['Emission Color'].default_value = (*lin(emission), 1.0)
        bsdf.inputs['Emission Strength'].default_value = strength
    m.use_backface_culling = not double
    m.diffuse_color = (*lin(color), 1.0)
    return m


def new_empty(name, loc, parent=None):
    o = bpy.data.objects.new(name, None)
    o.empty_display_size = 0.05
    link(o)
    o.parent = parent
    o.location = loc
    return o


def rot_matrix(rot):
    if rot is None:
        return Matrix.Identity(4)
    return Euler(tuple(math.radians(a) for a in rot), 'XYZ').to_matrix().to_4x4()


BOX_FACES = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]


class Part:
    """관절 위치(joint)를 원점으로 하는 메시 노드 하나. 좌표는 모두 캐릭터(또는 월드) 기준으로 넣는다."""

    def __init__(self, name, joint=(0, 0, 0), bevel=0.012, uv_mode=None, uv_tile=2.0):
        self.name = name
        self.joint = Vector(joint)
        self.bm = bmesh.new()
        self.mats = []
        self.bevel = bevel
        self.uv_mode = uv_mode     # None | 'world' | 'box' | 'wallv'
        self.uv_tile = uv_tile
        self.prim_bounds = []      # 'box'/'wallv' UV 용: 프리미티브별 (lo, hi)
        if uv_mode:
            self.uv = self.bm.loops.layers.uv.verify()
            self.prim_layer = self.bm.faces.layers.int.new('prim')

    def _mi(self, mat):
        if mat not in self.mats:
            self.mats.append(mat)
        return self.mats.index(mat)

    def _add(self, verts, faces, mat, bevel=0.0, recalc=True):
        bm = self.bm
        before = set(bm.faces) if self.uv_mode in ('box', 'wallv') else None
        vs = [bm.verts.new(v) for v in verts]
        fs = []
        for f in faces:
            try:
                fs.append(bm.faces.new([vs[i] for i in f]))
            except ValueError:
                pass
        mi = self._mi(mat)
        for f in fs:
            f.material_index = mi
        if recalc:
            bmesh.ops.recalc_face_normals(bm, faces=fs)
        if bevel > 0:
            edges = list({e for f in fs for e in f.edges})
            bmesh.ops.bevel(bm, geom=edges, offset=bevel, offset_type='OFFSET', segments=1,
                            profile=0.5, affect='EDGES', clamp_overlap=True, material=mi)
        if before is not None:
            # 베벨이 원래 면을 새 면으로 바꾸므로 '이번에 생긴 모든 면'에 프리미티브 번호를 붙여 둔다.
            lo = Vector((min(v[0] for v in verts), min(v[1] for v in verts), min(v[2] for v in verts)))
            hi = Vector((max(v[0] for v in verts), max(v[1] for v in verts), max(v[2] for v in verts)))
            self.prim_bounds.append((lo, hi))
            idx = len(self.prim_bounds) - 1
            for f in bm.faces:
                if f not in before:
                    f[self.prim_layer] = idx

    def _box_m(self, M, size, mat, bevel):
        hx, hy, hz = size[0] / 2, size[1] / 2, size[2] / 2
        local = [(-hx, -hy, -hz), (hx, -hy, -hz), (hx, hy, -hz), (-hx, hy, -hz),
                 (-hx, -hy, hz), (hx, -hy, hz), (hx, hy, hz), (-hx, hy, hz)]
        verts = [M @ Vector(v) for v in local]
        b = self.bevel if bevel is None else bevel
        b = min(b, min(size) / 4)
        return self._add(verts, BOX_FACES, mat, bevel=b)

    def box(self, c, s, mat, rot=None, bevel=None):
        return self._box_m(Matrix.Translation(Vector(c)) @ rot_matrix(rot), s, mat, bevel)

    def tbox(self, cxy, z0, z1, bot, top, mat, top_off=(0, 0), bevel=None):
        """아래(z0)와 위(z1) 단면 크기가 다른 사다리꼴 박스."""
        cx, cy = cxy
        bx, by = bot[0] / 2, bot[1] / 2
        tx, ty = top[0] / 2, top[1] / 2
        ox, oy = top_off
        verts = [(cx - bx, cy - by, z0), (cx + bx, cy - by, z0), (cx + bx, cy + by, z0), (cx - bx, cy + by, z0),
                 (cx + ox - tx, cy + oy - ty, z1), (cx + ox + tx, cy + oy - ty, z1),
                 (cx + ox + tx, cy + oy + ty, z1), (cx + ox - tx, cy + oy + ty, z1)]
        b = self.bevel if bevel is None else bevel
        b = min(b, min(bot[0], bot[1], top[0], top[1], z1 - z0) / 4)
        return self._add([Vector(v) for v in verts], BOX_FACES, mat, bevel=b)

    def beam(self, p0, p1, w, h, mat, bevel=None):
        """p0→p1 을 잇는 직육면체(팔·다리 등)."""
        p0, p1 = Vector(p0), Vector(p1)
        d = p1 - p0
        length = d.length
        dn = d.normalized()
        ref = Vector((0, 0, 1)) if abs(dn.z) < 0.95 else Vector((0, 1, 0))
        side = dn.cross(ref).normalized()
        up = side.cross(dn).normalized()
        R = Matrix((side, up, dn)).transposed().to_4x4()
        M = Matrix.Translation((p0 + p1) / 2) @ R
        return self._box_m(M, (w, h, length), mat, bevel)

    def frustum(self, p0, p1, r0, r1, mat, segs=12, caps=True, arc=None):
        """p0→p1 축의 원기둥/원뿔대. arc=(시작각, 끝각) 이면 열린 곡면(양면 머티리얼과 함께 쓴다)."""
        p0, p1 = Vector(p0), Vector(p1)
        dn = (p1 - p0).normalized()
        if abs(dn.z) > 0.9:
            u = Vector((1, 0, 0))
        else:
            u = Vector((0, 0, 1)).cross(dn).normalized()
        v = dn.cross(u).normalized()
        if arc:
            a0, a1 = math.radians(arc[0]), math.radians(arc[1])
            angles = [a0 + (a1 - a0) * i / segs for i in range(segs + 1)]
        else:
            angles = [2 * math.pi * i / segs for i in range(segs)]
        n = len(angles)
        verts = [p0 + (u * math.cos(a) + v * math.sin(a)) * r0 for a in angles]
        verts += [p1 + (u * math.cos(a) + v * math.sin(a)) * r1 for a in angles]
        faces = []
        count = n - 1 if arc else n
        for i in range(count):
            j = (i + 1) % n
            faces.append((i, j, n + j, n + i))
        if caps and not arc:
            faces.append(tuple(reversed(range(n))))
            faces.append(tuple(range(n, 2 * n)))
        return self._add(verts, faces, mat, recalc=not arc)

    def sphere(self, c, r, mat, scale=(1, 1, 1), segs=12, rings=8):
        c = Vector(c)
        sx, sy, sz = scale
        verts = [c + Vector((0, 0, r * sz))]
        for i in range(1, rings):
            phi = math.pi * i / rings
            for j in range(segs):
                th = 2 * math.pi * j / segs
                verts.append(c + Vector((r * sx * math.sin(phi) * math.cos(th),
                                         r * sy * math.sin(phi) * math.sin(th),
                                         r * sz * math.cos(phi))))
        verts.append(c + Vector((0, 0, -r * sz)))
        bottom = len(verts) - 1
        faces = []
        for j in range(segs):
            faces.append((0, 1 + j, 1 + (j + 1) % segs))
        for i in range(rings - 2):
            a, b = 1 + i * segs, 1 + (i + 1) * segs
            for j in range(segs):
                k = (j + 1) % segs
                faces.append((a + j, b + j, b + k, a + k))
        last = 1 + (rings - 2) * segs
        for j in range(segs):
            faces.append((last + j, bottom, last + (j + 1) % segs))
        return self._add(verts, faces, mat)

    def torus(self, c, R, r, mat, axis='Y', segs=24, rsegs=6):
        c = Vector(c)
        ax = {'X': Vector((1, 0, 0)), 'Y': Vector((0, 1, 0)), 'Z': Vector((0, 0, 1))}[axis]
        e1 = Vector((0, 0, 1)) if axis != 'Z' else Vector((1, 0, 0))
        e2 = ax.cross(e1).normalized()
        verts = []
        for i in range(segs):
            a = 2 * math.pi * i / segs
            radial = e1 * math.cos(a) + e2 * math.sin(a)
            for j in range(rsegs):
                b = 2 * math.pi * j / rsegs
                verts.append(c + radial * (R + r * math.cos(b)) + ax * (r * math.sin(b)))
        faces = []
        for i in range(segs):
            for j in range(rsegs):
                i2, j2 = (i + 1) % segs, (j + 1) % rsegs
                faces.append((i * rsegs + j, i2 * rsegs + j, i2 * rsegs + j2, i * rsegs + j2))
        return self._add(verts, faces, mat)

    def ring_solid(self, c, r_in, r_out, z0, z1, mat, segs=48):
        """수평 고리(바닥 마킹용). c 는 (x, y) 중심."""
        cx, cy = c
        verts = []
        for i in range(segs):
            a = 2 * math.pi * i / segs
            ca, sa = math.cos(a), math.sin(a)
            verts += [(cx + ca * r_out, cy + sa * r_out, z1), (cx + ca * r_in, cy + sa * r_in, z1),
                      (cx + ca * r_out, cy + sa * r_out, z0), (cx + ca * r_in, cy + sa * r_in, z0)]
        faces = []
        for i in range(segs):
            a, b = i * 4, ((i + 1) % segs) * 4
            faces += [(a, b, b + 1, a + 1), (a + 2, a + 3, b + 3, b + 2),
                      (a, a + 2, b + 2, b), (a + 1, b + 1, b + 3, a + 3)]
        return self._add([Vector(v) for v in verts], faces, mat)

    def finish(self, parent=None, parent_joint=(0, 0, 0)):
        bm = self.bm
        if self.uv_mode:
            bm.normal_update()
        if self.uv_mode == 'world':
            _planar_uv(bm.faces, self.uv, Vector((0, 0, 0)), Vector((self.uv_tile,) * 3))
        elif self.uv_mode in ('box', 'wallv'):
            for f in bm.faces:
                lo, hi = self.prim_bounds[f[self.prim_layer]]
                if self.uv_mode == 'box':
                    _planar_uv([f], self.uv, lo, hi - lo)
                else:
                    _wall_uv([f], self.uv, lo, hi, self.uv_tile)
        bmesh.ops.translate(bm, verts=bm.verts, vec=-self.joint)
        # 각진 면은 날카롭게, 원기둥·구는 부드럽게(자동 스무스와 같은 효과)
        for f in bm.faces:
            f.smooth = True
        limit = math.radians(40)
        for e in bm.edges:
            if len(e.link_faces) == 2:
                e.smooth = e.calc_face_angle(math.pi) <= limit
            else:
                e.smooth = False
        me = bpy.data.meshes.new(self.name)
        bm.to_mesh(me)
        bm.free()
        for m in self.mats:
            me.materials.append(m)
        o = link(bpy.data.objects.new(self.name, me))
        o.parent = parent
        o.location = self.joint - Vector(parent_joint)
        return o


def _planar_uv(faces, uv_layer, origin, extent):
    """면 법선의 주축 기준 평면 투영. 세로면은 v=Z(위쪽)로 맞춘다."""
    for f in faces:
        n = f.normal
        ax = max(range(3), key=lambda i: abs(n[i]))
        for loop in f.loops:
            co = loop.vert.co - origin
            if ax == 0:
                uv = (co.y / extent.y, co.z / extent.z)
            elif ax == 1:
                uv = (co.x / extent.x, co.z / extent.z)
            else:
                uv = (co.x / extent.x, co.y / extent.y)
            loop[uv_layer].uv = uv


def _wall_uv(faces, uv_layer, lo, hi, tile):
    """가로는 월드 타일, 세로는 박스 높이 0..1(텍스처 위쪽 띠가 항상 박스 윗단에 오게)."""
    h = max(hi.z - lo.z, 1e-6)
    for f in faces:
        n = f.normal
        ax = max(range(3), key=lambda i: abs(n[i]))
        for loop in f.loops:
            co = loop.vert.co
            if ax == 2:
                uv = (co.x / tile + co.y / tile, 0.9)
            else:
                # 0/1 경계에서 REPEAT 필터가 반대쪽 줄(경고 띠)을 섞지 않게 살짝 안쪽으로
                uv = ((co.y if ax == 0 else co.x) / tile, 0.01 + 0.98 * (co.z - lo.z) / h)
            loop[uv_layer].uv = uv


def export_glb(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB', export_apply=True, export_yup=True,
        export_animations=False, export_cameras=False, export_lights=False, export_extras=False,
        export_materials='EXPORT', export_image_format='AUTO', export_texcoords=True,
        export_normals=True, export_tangents=False, use_selection=False,
    )
    log('wrote', os.path.relpath(path, ROOT), f'{os.path.getsize(path) / 1024:.1f} KB')


# ─────────────────────────────────────────────────────────────
# 히어로
# ─────────────────────────────────────────────────────────────
def hero_mats(hid):
    h = HEROES[hid]
    return {
        'P': make_mat('Primary', h['primary'], metallic=0.25, roughness=0.45),
        'A': make_mat('Accent', h['accent'], metallic=0.2, roughness=0.4),
        'D': make_mat('Dark', '#25282e', metallic=0.4, roughness=0.55),
        'M': make_mat('Metal', '#8b929b', metallic=0.85, roughness=0.3),
        'V': make_mat('Visor', '#101215', roughness=0.2, emission=h['accent'], strength=2.5),
        'G': make_mat('Glow', h['accent'], emission=h['accent'], strength=3.0),
        'T': make_mat('Team', '#e8e8e8', roughness=0.4, emission='#ffffff', strength=0.6),
    }


def legs_simple(M, joint_z, x, thigh_w, shin_w, mats_leg, knee_mat, boot_mat, glow=None):
    """날렵한 체형용 다리(벡스·루크·솔)."""
    out = {}
    for side, name in ((-1, 'legL'), (1, 'legR')):
        sx = x * side
        L = Part(name, (sx, 0, joint_z))
        L.beam((sx, 0, joint_z), (sx, 0.02, 0.5), thigh_w, thigh_w + 0.02, mats_leg)
        L.box((sx, 0.075, 0.49), (shin_w - 0.02, 0.07, 0.1), knee_mat)
        L.beam((sx, 0.02, 0.5), (sx, -0.01, 0.1), shin_w, shin_w + 0.02, mats_leg)
        L.box((sx, 0.05, 0.06), (shin_w + 0.01, 0.3, 0.12), boot_mat)
        if glow is not None:
            L.box((sx, 0.075, 0.3), (0.02, 0.012, 0.24), glow)
        out[name] = L
    return out


# 무기는 히어로 모델과 1인칭 모델이 같은 함수를 쓴다. (Part, 총구 위치)를 돌려준다.
def weapon_kodiak(M):
    W = Part('weapon', (0.2, 0.36, 1.1))
    W.box((0.2, 0.62, 1.17), (0.3, 0.72, 0.28), M['D'])
    W.box((0.2, 0.6, 1.335), (0.2, 0.5, 0.06), M['A'])
    for bx in (0.13, 0.27):
        W.frustum((bx, 0.95, 1.2), (bx, 1.3, 1.2), 0.075, 0.075, M['M'], segs=10)
        W.frustum((bx, 1.28, 1.2), (bx, 1.31, 1.2), 0.085, 0.085, M['D'], segs=10)
    W.frustum((0.07, 0.52, 1.03), (0.33, 0.52, 1.03), 0.13, 0.13, M['A'], segs=12)
    W.box((0.2, 0.33, 1.02), (0.1, 0.1, 0.18), M['D'])
    W.box((0.355, 0.66, 1.2), (0.012, 0.46, 0.05), M['G'])
    W.box((0.045, 0.66, 1.2), (0.012, 0.46, 0.05), M['G'])
    return W, Vector((0.2, 1.32, 1.2))


def weapon_vex(M):
    W = Part('weapon', (0.12, 0.24, 1.1))
    W.box((0.11, 0.4, 1.15), (0.075, 0.4, 0.11), M['D'])
    W.box((0.11, 0.13, 1.13), (0.06, 0.16, 0.09), M['P'])
    W.box((0.11, 0.66, 1.16), (0.065, 0.14, 0.075), M['P'])
    W.frustum((0.11, 0.72, 1.16), (0.11, 0.8, 1.16), 0.02, 0.018, M['M'], segs=8)
    W.box((0.11, 0.34, 1.045), (0.05, 0.08, 0.13), M['D'], rot=(12, 0, 0))
    W.box((0.11, 0.44, 1.225), (0.03, 0.1, 0.03), M['D'])
    W.box((0.15, 0.42, 1.15), (0.008, 0.3, 0.02), M['G'])
    W.box((0.07, 0.42, 1.15), (0.008, 0.3, 0.02), M['G'])
    W.box((0.11, 0.25, 1.065), (0.04, 0.05, 0.1), M['D'])
    return W, Vector((0.11, 0.81, 1.16))


def weapon_ember(M):
    W = Part('weapon', (0.22, 0.2, 1.1))
    W.frustum((0.22, -0.2, 1.24), (0.22, 0.82, 1.24), 0.11, 0.11, M['D'], segs=12)
    W.frustum((0.22, 0.78, 1.24), (0.22, 0.86, 1.24), 0.13, 0.13, M['A'], segs=12)
    W.frustum((0.22, -0.24, 1.24), (0.22, -0.16, 1.24), 0.125, 0.125, M['A'], segs=12)
    W.frustum((0.22, 0.86, 1.24), (0.22, 0.866, 1.24), 0.085, 0.085, M['G'], segs=12)
    W.box((0.36, 0.25, 1.24), (0.06, 0.4, 0.12), M['P'])
    W.box((0.395, 0.25, 1.24), (0.01, 0.3, 0.03), M['G'])
    W.box((0.22, 0.2, 1.11), (0.05, 0.07, 0.17), M['D'])
    W.box((0.15, 0.5, 1.13), (0.05, 0.07, 0.14), M['D'])
    W.box((0.22, 0.4, 1.37), (0.04, 0.14, 0.04), M['A'])
    return W, Vector((0.22, 0.87, 1.24))


def weapon_rook(M):
    W = Part('weapon', (0.12, 0.2, 1.27))
    W.box((0.12, -0.12, 1.3), (0.06, 0.26, 0.13), M['D'])
    W.box((0.12, -0.06, 1.38), (0.05, 0.14, 0.04), M['P'])
    W.box((0.12, 0.3, 1.32), (0.085, 0.5, 0.11), M['D'])
    W.box((0.12, 0.86, 1.355), (0.04, 0.62, 0.025), M['M'])
    W.box((0.12, 0.86, 1.285), (0.04, 0.62, 0.025), M['M'])
    W.box((0.12, 0.86, 1.32), (0.015, 0.6, 0.03), M['G'])
    W.box((0.12, 1.17, 1.32), (0.07, 0.04, 0.1), M['D'])
    W.frustum((0.12, 0.16, 1.43), (0.12, 0.52, 1.43), 0.035, 0.035, M['D'], segs=10)
    W.frustum((0.12, 0.521, 1.43), (0.12, 0.525, 1.43), 0.028, 0.028, M['V'], segs=10)
    W.box((0.12, 0.25, 1.39), (0.02, 0.03, 0.05), M['D'])
    W.box((0.12, 0.43, 1.39), (0.02, 0.03, 0.05), M['D'])
    W.box((0.12, 0.2, 1.22), (0.04, 0.05, 0.1), M['D'])
    return W, Vector((0.12, 1.2, 1.32))


def weapon_sol(M):
    W = Part('weapon', (0.2, 0.2, 1.15))
    W.box((0.2, 0.36, 1.15), (0.15, 0.34, 0.15), M['A'])
    W.box((0.2, 0.36, 1.235), (0.11, 0.28, 0.02), M['P'])
    W.box((0.2, 0.36, 1.065), (0.11, 0.28, 0.02), M['P'])
    W.frustum((0.2, 0.5, 1.15), (0.2, 0.56, 1.15), 0.07, 0.07, M['D'], segs=12)
    W.sphere((0.2, 0.585, 1.15), 0.055, M['G'], segs=10, rings=6)
    W.box((0.278, 0.36, 1.15), (0.01, 0.26, 0.02), M['G'])
    W.box((0.122, 0.36, 1.15), (0.01, 0.26, 0.02), M['G'])
    return W, Vector((0.2, 0.64, 1.15))


def hero_kodiak(M):
    P, A, D, Mt, V, T, G = (M[k] for k in 'PADMVTG')
    hips = Part('hips', (0, 0, 0.95))
    hips.box((0, 0, 0.98), (0.62, 0.42, 0.3), D)
    hips.box((0, 0.2, 0.92), (0.4, 0.06, 0.22), P)
    hips.box((0, -0.2, 0.94), (0.46, 0.06, 0.2), P)
    parts = {'hips': hips}
    for side, name in ((-1, 'legL'), (1, 'legR')):
        x = 0.21 * side
        L = Part(name, (x, 0, 0.92))
        L.box((x, 0, 0.7), (0.27, 0.32, 0.44), P)
        L.box((x + 0.02 * side, 0.14, 0.47), (0.24, 0.12, 0.2), A)
        L.tbox((x, 0), 0.1, 0.48, (0.32, 0.36), (0.27, 0.3), D)
        L.box((x, 0.12, 0.3), (0.26, 0.1, 0.26), P)
        L.box((x, 0.07, 0.06), (0.33, 0.52, 0.12), D)
        parts[name] = L
    T_ = Part('torso', (0, 0, 1.05))
    T_.box((0, 0, 1.12), (0.5, 0.36, 0.18), D)
    T_.tbox((0, 0), 1.18, 1.66, (0.62, 0.42), (0.8, 0.5), P)
    T_.box((0, 0.24, 1.44), (0.58, 0.08, 0.3), A)
    T_.box((0, 0.285, 1.44), (0.6, 0.02, 0.06), T)
    T_.box((0, -0.33, 1.42), (0.62, 0.26, 0.52), D)
    T_.box((0, -0.465, 1.42), (0.5, 0.02, 0.06), T)
    for sx in (-0.18, 0.18):
        T_.frustum((sx, -0.42, 1.5), (sx, -0.42, 1.8), 0.06, 0.05, Mt, segs=10)
    T_.box((0, 0, 1.68), (0.44, 0.44, 0.08), D)
    parts['torso'] = T_
    Hd = Part('head', (0, 0, 1.7))
    Hd.tbox((0, 0.02), 1.7, 2.02, (0.36, 0.4), (0.3, 0.34), P)
    Hd.box((0, 0.2, 1.87), (0.3, 0.05, 0.09), V)
    Hd.box((0, 0.215, 1.77), (0.22, 0.06, 0.1), D)
    Hd.box((0, -0.02, 2.06), (0.07, 0.3, 0.08), A)
    parts['head'] = Hd
    for side, name in ((-1, 'armL'), (1, 'armR')):
        sx = 0.46 * side
        Ar = Part(name, (sx, 0, 1.56))
        Ar.box((0.5 * side, 0, 1.62), (0.34, 0.48, 0.3), P)
        Ar.box((0.5 * side, 0, 1.79), (0.28, 0.4, 0.06), A)
        Ar.box((0.668 * side, 0, 1.62), (0.012, 0.3, 0.1), T)
        Ar.box((0.48 * side, 0.02, 1.38), (0.22, 0.24, 0.34), D)
        parts[name] = Ar
    parts['armR'].beam((0.48, 0.06, 1.24), (0.24, 0.36, 1.1), 0.2, 0.2, P)
    parts['armR'].box((0.21, 0.38, 1.1), (0.16, 0.18, 0.16), D)
    parts['armL'].beam((-0.48, 0.06, 1.26), (-0.3, 0.38, 1.18), 0.19, 0.19, D)
    parts['armL'].beam((-0.3, 0.38, 1.18), (0.0, 0.62, 1.12), 0.19, 0.19, P)
    parts['armL'].box((0.02, 0.64, 1.12), (0.15, 0.17, 0.16), D)
    return parts


def hero_vex(M):
    P, A, D, Mt, V, T, G = (M[k] for k in 'PADMVTG')
    hips = Part('hips', (0, 0, 0.88))
    hips.box((0, 0, 0.9), (0.34, 0.22, 0.16), D)
    hips.box((0, 0.1, 0.9), (0.2, 0.04, 0.05), G)
    parts = {'hips': hips}
    parts.update(legs_simple(M, 0.86, 0.11, 0.15, 0.13, P, D, D, glow=G))
    for side in (-1, 1):
        parts['legL' if side < 0 else 'legR'].box((0.11 * side, -0.1, 0.33), (0.04, 0.08, 0.22), D)
    T_ = Part('torso', (0, 0, 0.95))
    T_.box((0, 0, 1.03), (0.26, 0.18, 0.18), D)
    T_.tbox((0, 0), 1.08, 1.44, (0.3, 0.2), (0.44, 0.26), P)
    for side in (-1, 1):
        T_.beam((0.17 * side, 0.128, 1.41), (0.0, 0.112, 1.2), 0.025, 0.015, G)
    T_.box((0, -0.16, 1.28), (0.22, 0.1, 0.26), D)
    T_.box((0, -0.215, 1.28), (0.04, 0.012, 0.2), G)
    T_.box((0, -0.215, 1.4), (0.3, 0.012, 0.04), T)
    T_.box((0, 0.112, 1.12), (0.24, 0.012, 0.04), T)
    T_.box((0, 0, 1.45), (0.2, 0.18, 0.06), D)
    parts['torso'] = T_
    Hd = Part('head', (0, 0, 1.46))
    Hd.frustum((0, 0, 1.44), (0, 0, 1.52), 0.06, 0.06, D, segs=10)
    Hd.sphere((0, 0, 1.63), 0.14, P, scale=(1, 1.12, 1.22))
    Hd.box((0, 0.125, 1.645), (0.2, 0.06, 0.055), V)
    for side in (-1, 1):
        Hd.box((0.135 * side, 0, 1.62), (0.04, 0.1, 0.1), A)
    Hd.box((0, -0.08, 1.76), (0.02, 0.14, 0.06), A)
    parts['head'] = Hd
    for side, name in ((-1, 'armL'), (1, 'armR')):
        Ar = Part(name, (0.24 * side, 0, 1.38))
        Ar.box((0.27 * side, 0, 1.4), (0.14, 0.18, 0.12), P)
        Ar.box((0.27 * side, 0, 1.465), (0.12, 0.16, 0.02), A)
        Ar.box((0.342 * side, 0, 1.4), (0.012, 0.1, 0.04), T)
        parts[name] = Ar
    parts['armR'].beam((0.25, 0, 1.36), (0.27, 0.06, 1.16), 0.09, 0.1, P)
    parts['armR'].beam((0.27, 0.06, 1.16), (0.13, 0.24, 1.1), 0.085, 0.09, D)
    parts['armR'].box((0.12, 0.25, 1.1), (0.08, 0.09, 0.09), D)
    parts['armL'].beam((-0.25, 0, 1.36), (-0.22, 0.18, 1.18), 0.09, 0.1, P)
    parts['armL'].beam((-0.22, 0.18, 1.18), (0.06, 0.42, 1.12), 0.085, 0.09, D)
    parts['armL'].box((0.07, 0.43, 1.12), (0.08, 0.09, 0.09), D)
    return parts


def hero_ember(M):
    P, A, D, Mt, V, T, G = (M[k] for k in 'PADMVTG')
    hips = Part('hips', (0, 0, 0.9))
    hips.box((0, 0, 0.92), (0.38, 0.24, 0.18), D)
    for side in (-1, 1):
        hips.box((0.17 * side, 0.1, 0.92), (0.08, 0.06, 0.1), A)
    parts = {'hips': hips}
    for side, name in ((-1, 'legL'), (1, 'legR')):
        x = 0.12 * side
        L = Part(name, (x, 0, 0.88))
        L.box((x, 0, 0.68), (0.17, 0.2, 0.38), P)
        L.box((x, 0.1, 0.49), (0.14, 0.08, 0.12), A)
        L.tbox((x, 0), 0.11, 0.48, (0.18, 0.22), (0.15, 0.18), P)
        L.box((x, 0.05, 0.07), (0.18, 0.34, 0.11), D)
        L.box((x, 0.05, 0.012), (0.19, 0.35, 0.024), A)
        parts[name] = L
    T_ = Part('torso', (0, 0, 0.99))
    T_.box((0, 0, 1.06), (0.3, 0.2, 0.16), D)
    T_.tbox((0, 0), 1.1, 1.48, (0.36, 0.24), (0.5, 0.3), P)
    T_.box((0, 0.14, 1.34), (0.3, 0.04, 0.16), A)
    T_.box((0, 0.155, 1.2), (0.3, 0.012, 0.04), T)
    T_.box((0, -0.25, 1.3), (0.42, 0.18, 0.42), D)
    T_.box((0, -0.25, 1.525), (0.36, 0.14, 0.03), A)
    for side in (-1, 1):
        T_.box((0.215 * side, -0.25, 1.3), (0.012, 0.14, 0.04), T)
        T_.frustum((0.12 * side, -0.37, 1.1), (0.12 * side, -0.37, 1.48), 0.06, 0.06, Mt, segs=10)
        T_.frustum((0.13 * side, -0.3, 1.1), (0.15 * side, -0.36, 0.92), 0.07, 0.1, Mt, segs=12)
        T_.frustum((0.15 * side, -0.362, 0.93), (0.152 * side, -0.364, 0.915), 0.085, 0.085, G, segs=12)
    T_.box((0, 0, 1.49), (0.24, 0.2, 0.06), D)
    parts['torso'] = T_
    Hd = Part('head', (0, 0, 1.5))
    Hd.tbox((0, 0.01), 1.5, 1.78, (0.24, 0.27), (0.21, 0.24), P)
    Hd.box((0, 0.135, 1.665), (0.19, 0.03, 0.04), V)
    Hd.box((0, 0.14, 1.56), (0.12, 0.06, 0.08), D)
    for side in (-1, 1):
        Hd.frustum((0.07 * side, 0.15, 1.55), (0.1 * side, 0.19, 1.53), 0.03, 0.03, Mt, segs=8)
    Hd.box((0, -0.02, 1.81), (0.04, 0.22, 0.08), A)
    parts['head'] = Hd
    for side, name in ((-1, 'armL'), (1, 'armR')):
        Ar = Part(name, (0.29 * side, 0, 1.42))
        Ar.box((0.31 * side, 0, 1.44), (0.16, 0.22, 0.14), P)
        Ar.box((0.31 * side, 0, 1.52), (0.14, 0.2, 0.02), A)
        Ar.box((0.392 * side, 0, 1.44), (0.012, 0.12, 0.04), T)
        parts[name] = Ar
    parts['armR'].beam((0.3, 0, 1.4), (0.31, 0.04, 1.18), 0.1, 0.11, P)
    parts['armR'].beam((0.31, 0.04, 1.18), (0.22, 0.2, 1.1), 0.09, 0.1, D)
    parts['armR'].box((0.22, 0.21, 1.1), (0.09, 0.1, 0.1), D)
    parts['armL'].beam((-0.3, 0, 1.4), (-0.24, 0.2, 1.18), 0.1, 0.11, P)
    parts['armL'].beam((-0.24, 0.2, 1.18), (0.12, 0.5, 1.12), 0.09, 0.1, D)
    parts['armL'].box((0.13, 0.5, 1.12), (0.09, 0.1, 0.1), D)
    return parts


def hero_rook(M):
    P, A, D, Mt, V, T, G = (M[k] for k in 'PADMVTG')
    C = make_mat('Cloak', '#2b3324', roughness=0.85)
    hips = Part('hips', (0, 0, 0.88))
    hips.box((0, 0, 0.9), (0.32, 0.2, 0.16), D)
    for side in (-1, 1):
        hips.box((0.15 * side, 0.08, 0.88), (0.07, 0.06, 0.09), P)
    # 뒤로 늘어진 코트 자락(골반에 붙여 조준 피치에 휘둘리지 않게 한다)
    hips.tbox((0, -0.2), 0.48, 0.94, (0.44, 0.035), (0.36, 0.035), C, top_off=(0, 0.06))
    parts = {'hips': hips}
    parts.update(legs_simple(M, 0.86, 0.1, 0.14, 0.13, P, D, D))
    for side in (-1, 1):
        parts['legL' if side < 0 else 'legR'].box((0.18 * side, 0.0, 0.68), (0.04, 0.1, 0.12), D)
    T_ = Part('torso', (0, 0, 0.95))
    T_.box((0, 0, 1.02), (0.28, 0.18, 0.16), D)
    T_.tbox((0, 0), 1.06, 1.43, (0.32, 0.22), (0.42, 0.26), P)
    T_.beam((-0.18, 0.125, 1.38), (0.16, 0.115, 1.08), 0.05, 0.03, D)
    # 어깨 망토
    T_.tbox((0, -0.15), 1.08, 1.44, (0.5, 0.04), (0.46, 0.05), C, top_off=(0, 0.02))
    T_.box((0, 0.02, 1.45), (0.3, 0.26, 0.08), C)
    T_.box((0, -0.178, 1.3), (0.3, 0.012, 0.04), T)
    parts['torso'] = T_
    Hd = Part('head', (0, 0, 1.46))
    Hd.sphere((0, 0.02, 1.6), 0.12, D, scale=(1, 1.05, 1.2))
    for side in (-1, 1):
        Hd.frustum((0.05 * side, 0.1, 1.62), (0.05 * side, 0.15, 1.62), 0.028, 0.028, Mt, segs=8)
        Hd.frustum((0.05 * side, 0.151, 1.62), (0.05 * side, 0.155, 1.62), 0.022, 0.022, V, segs=8)
        Hd.box((0.14 * side, 0.03, 1.6), (0.03, 0.2, 0.28), C, rot=(0, -12 * side, 0))
    Hd.tbox((0, -0.08), 1.46, 1.8, (0.3, 0.2), (0.14, 0.14), C, top_off=(0, 0.02))
    Hd.box((0, 0.06, 1.75), (0.2, 0.15, 0.05), C, rot=(-15, 0, 0))
    Hd.beam((0.11, -0.1, 1.64), (0.15, -0.14, 1.84), 0.012, 0.012, Mt)
    parts['head'] = Hd
    for side, name in ((-1, 'armL'), (1, 'armR')):
        Ar = Part(name, (0.23 * side, 0, 1.38))
        Ar.box((0.26 * side, 0, 1.4), (0.13, 0.18, 0.12), P)
        Ar.box((0.328 * side, 0, 1.4), (0.012, 0.12, 0.04), T)
        parts[name] = Ar
    parts['armR'].beam((0.24, 0, 1.36), (0.29, 0.05, 1.18), 0.09, 0.1, P)
    parts['armR'].beam((0.29, 0.05, 1.18), (0.14, 0.2, 1.26), 0.085, 0.09, D)
    parts['armR'].box((0.13, 0.21, 1.27), (0.08, 0.09, 0.09), D)
    parts['armL'].beam((-0.24, 0, 1.36), (-0.22, 0.22, 1.2), 0.09, 0.1, P)
    parts['armL'].beam((-0.22, 0.22, 1.2), (0.08, 0.6, 1.26), 0.085, 0.09, D)
    parts['armL'].box((0.09, 0.61, 1.27), (0.08, 0.09, 0.09), D)
    return parts


def hero_sol(M):
    P, A, D, Mt, V, T, G = (M[k] for k in 'PADMVTG')
    Coat = make_mat('Coat', '#e4dccb', roughness=0.7, double=True)
    CoatTrim = make_mat('CoatTrim', HEROES['sol']['accent'], metallic=0.2, roughness=0.4, double=True)
    hips = Part('hips', (0, 0, 0.9))
    hips.box((0, 0, 0.92), (0.3, 0.2, 0.14), D)
    hips.frustum((0, 0, 0.9), (0, 0, 0.97), 0.175, 0.17, A, segs=12)
    # 앞이 트인 코트 자락(아래로 퍼짐). 각도 90° 가 정면(+Y).
    hips.frustum((0, 0, 0.4), (0, 0, 0.98), 0.36, 0.2, Coat, segs=12, arc=(125, 415))
    hips.frustum((0, 0, 0.39), (0, 0, 0.44), 0.365, 0.345, CoatTrim, segs=12, arc=(125, 415))
    parts = {'hips': hips}
    parts.update(legs_simple(M, 0.88, 0.1, 0.13, 0.12, D, A, P))
    T_ = Part('torso', (0, 0, 0.98))
    T_.tbox((0, 0), 1.0, 1.43, (0.28, 0.2), (0.4, 0.24), P)
    T_.frustum((0, 0, 1.4), (0, 0, 1.5), 0.16, 0.12, A, segs=12)
    T_.box((0, 0.12, 1.3), (0.07, 0.02, 0.07), G, rot=(0, 45, 0))
    T_.beam((-0.17, 0.118, 1.4), (0.15, 0.112, 1.05), 0.05, 0.015, T)
    T_.box((0, -0.15, 1.3), (0.2, 0.08, 0.2), D)
    T_.box((0, -0.192, 1.3), (0.03, 0.01, 0.16), G)
    parts['torso'] = T_
    Hd = Part('head', (0, 0, 1.47))
    Hd.frustum((0, 0, 1.45), (0, 0, 1.52), 0.05, 0.05, D, segs=10)
    Hd.sphere((0, 0.01, 1.6), 0.125, P, scale=(1, 1.08, 1.18))
    Hd.box((0, 0.11, 1.615), (0.17, 0.05, 0.05), V)
    Hd.torus((0, -0.17, 1.63), 0.16, 0.018, G, axis='Y', segs=24, rsegs=6)
    Hd.beam((0, -0.1, 1.6), (0, -0.17, 1.6), 0.02, 0.02, D)
    parts['head'] = Hd
    for side, name in ((-1, 'armL'), (1, 'armR')):
        Ar = Part(name, (0.22 * side, 0, 1.38))
        Ar.box((0.25 * side, 0, 1.4), (0.12, 0.16, 0.1), P)
        Ar.box((0.25 * side, 0, 1.455), (0.1, 0.14, 0.015), A)
        Ar.box((0.312 * side, 0, 1.4), (0.012, 0.1, 0.04), T)
        parts[name] = Ar
    parts['armR'].beam((0.23, 0, 1.36), (0.27, 0.04, 1.15), 0.085, 0.09, D)
    parts['armR'].beam((0.27, 0.04, 1.15), (0.2, 0.22, 1.15), 0.08, 0.085, P)
    parts['armL'].beam((-0.23, 0, 1.36), (-0.27, 0.06, 1.14), 0.085, 0.09, D)
    parts['armL'].beam((-0.27, 0.06, 1.14), (-0.22, 0.28, 1.02), 0.08, 0.085, P)
    parts['armL'].box((-0.22, 0.3, 1.0), (0.07, 0.08, 0.08), D)
    return parts


HERO_BUILDERS = {
    'kodiak': (hero_kodiak, weapon_kodiak, (0.02, 0.64, 1.12), 1.8),
    'vex': (hero_vex, weapon_vex, (0.07, 0.43, 1.12), 1.0),
    'ember': (hero_ember, weapon_ember, (0.13, 0.5, 1.12), 1.05),
    'rook': (hero_rook, weapon_rook, (0.09, 0.61, 1.27), 1.0),
    'sol': (hero_sol, weapon_sol, None, 1.0),
}


def build_hero(hid, out_dir):
    reset()
    M = hero_mats(hid)
    body_fn, weapon_fn, _, _ = HERO_BUILDERS[hid]
    parts = body_fn(M)
    W, muzzle = weapon_fn(M)
    parts['weapon'] = W
    root = new_empty('root', (0, 0, 0))
    objs = {'hips': parts['hips'].finish(root, (0, 0, 0))}
    for n in ('legL', 'legR', 'torso'):
        objs[n] = parts[n].finish(objs['hips'], parts['hips'].joint)
    for n in ('head', 'armL', 'armR', 'weapon'):
        objs[n] = parts[n].finish(objs['torso'], parts['torso'].joint)
    new_empty('muzzle', muzzle - W.joint, parent=objs['weapon'])
    export_glb(os.path.join(out_dir, f'hero_{hid}.glb'))


def build_fp_weapon(hid, out_dir):
    reset()
    M = hero_mats(hid)
    _, weapon_fn, lhand, k = HERO_BUILDERS[hid]
    W, muzzle = weapon_fn(M)
    grip = W.joint
    # 1인칭 팔: 손잡이(오른손)와 앞손잡이(왼손)에서 화면 아래·바깥으로 빠지는 팔뚝
    w = 0.09 * (1.35 if k > 1.5 else 1.0)
    rback = grip + Vector((0.07, -0.44, -0.18))
    W.beam(rback, grip, w, w * 1.1, M['P'])
    W.box(grip + Vector((0, 0.01, 0)), (w * 1.05, w * 1.1, w * 1.1), M['D'])
    if lhand is not None:
        lh = Vector(lhand)
        lback = lh + Vector((-0.2, -0.36, -0.18))
        W.beam(lback, lh, w, w * 1.1, M['P'])
        W.box(lh, (w * 1.05, w * 1.1, w * 1.1), M['D'])
    o = W.finish(None, grip)
    o.location = (0, 0, 0)
    new_empty('muzzle', muzzle - grip, parent=o)
    export_glb(os.path.join(out_dir, f'weapon_{hid}.glb'))


# ─────────────────────────────────────────────────────────────
# 절차 텍스처 (numpy, sRGB 값으로 기록)
# ─────────────────────────────────────────────────────────────
def _value_noise(n, cells, rng):
    g = rng.random((cells, cells))
    t = np.arange(n) * cells / n
    i0 = np.floor(t).astype(int) % cells
    i1 = (i0 + 1) % cells
    f = t - np.floor(t)
    f = f * f * (3 - 2 * f)
    a, b = g[i0][:, i0], g[i0][:, i1]
    c, d = g[i1][:, i0], g[i1][:, i1]
    fx, fy = f[None, :], f[:, None]
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy


def fbm(n, seed, octaves=(4, 8, 16, 32), persistence=0.55):
    rng = np.random.default_rng(seed)
    total = np.zeros((n, n))
    amp, norm = 1.0, 0.0
    for cells in octaves:
        total += amp * _value_noise(n, cells, rng)
        norm += amp
        amp *= persistence
    return total / norm


def _coords(n):
    yy, xx = np.mgrid[0:n, 0:n]
    return xx, yy


def _shade(base, mult):
    return np.clip(np.asarray(base)[None, None, :] * mult[..., None], 0, 1)


def tex_ground(n=512):
    xx, yy = _coords(n)
    rng = np.random.default_rng(11)
    m = 0.82 + 0.3 * fbm(n, 1, (4, 8, 16, 32, 64))
    m += (rng.random((n, n)) - 0.5) * 0.06
    seam = ((xx % 256) < 3) | ((yy % 256) < 3)
    m = np.where(seam, m * 0.6, m)
    return _shade((0.31, 0.32, 0.34), m)


def tex_concrete_panels(n=256):
    xx, yy = _coords(n)
    m = 0.85 + 0.25 * fbm(n, 2)
    seam = ((xx % 128) < 2) | ((yy % 128) < 2)
    m = np.where(seam, m * 0.55, m)
    for cx in (20, 108):
        for cy in (20, 108):
            d = ((xx % 128) - cx) ** 2 + ((yy % 128) - cy) ** 2
            m = np.where(d < 9, m * 0.6, m)
    return _shade((0.63, 0.61, 0.57), m)


def tex_metal_panels(n=256):
    xx, yy = _coords(n)
    rng = np.random.default_rng(3)
    streak = _value_noise(n, 64, rng)[:1, :].repeat(n, 0)
    m = 0.88 + 0.1 * fbm(n, 4) + 0.06 * streak
    seam = ((xx % 128) < 2) | ((yy % 128) < 2)
    m = np.where(seam, m * 0.55, m)
    rivet = (((xx % 128) - 8) % 16 < 3) & ((((yy % 128) - 6) ** 2) < 3)
    m = np.where(rivet, m * 1.25, m)
    return _shade((0.5, 0.55, 0.61), m)


def tex_corrugated(n=256):
    xx, _ = _coords(n)
    m = 0.82 + 0.18 * np.sin(2 * np.pi * xx / 16) + 0.12 * fbm(n, 5)
    rgb = _shade((0.4, 0.42, 0.45), m)
    rust = np.clip((fbm(n, 6) - 0.62) * 4, 0, 1)[..., None]
    return np.clip(rgb * (1 - rust * 0.5) + np.array((0.45, 0.24, 0.12)) * rust * 0.5, 0, 1)


def tex_blocks(n=256):
    xx, yy = _coords(n)
    m = 0.85 + 0.25 * fbm(n, 7)
    row = yy // 64
    off = (row % 2) * 64
    joint = ((yy % 64) < 2) | (((xx + off) % 128) < 2)
    m = np.where(joint, m * 0.55, m)
    return _shade((0.57, 0.53, 0.47), m)


def tex_grating(n=256):
    xx, yy = _coords(n)
    bar = ((xx % 16) < 4) | ((yy % 16) < 4)
    m = np.where(bar, 1.0, 0.42) * (0.9 + 0.15 * fbm(n, 8))
    return _shade((0.42, 0.44, 0.47), m)


def tex_cover(n=256):
    xx, yy = _coords(n)
    grime = 0.78 + 0.25 * fbm(n, 9)
    concrete = _shade((0.58, 0.58, 0.6), grime)
    stripe = (((xx + yy) // 24) % 2).astype(bool)
    hazard = np.where(stripe[..., None], np.array((0.92, 0.72, 0.12)), np.array((0.13, 0.13, 0.14)))
    hazard = hazard * grime[..., None]
    band = (yy >= int(n * 0.78))[..., None]   # 위쪽 22% 경고 띠 (v=높이)
    return np.clip(np.where(band, hazard, concrete), 0, 1)


def tex_crate(n=256):
    xx, yy = _coords(n)
    m = 0.85 + 0.22 * fbm(n, 10)
    border = (xx < 20) | (xx >= n - 20) | (yy < 20) | (yy >= n - 20)
    brace = (np.abs(xx - yy) < 9) | (np.abs(xx + yy - n) < 9)
    rgb = _shade((0.8, 0.43, 0.17), m)
    dark = _shade((0.42, 0.24, 0.1), m)
    mask = (border | brace)[..., None]
    rgb = np.where(mask, dark, rgb)
    label = (xx > 150) & (xx < 225) & (yy > 32) & (yy < 62)
    return np.where(label[..., None], _shade((0.9, 0.88, 0.8), m), rgb)


def tex_concrete(n=256):
    _, yy = _coords(n)
    m = 0.85 + 0.25 * fbm(n, 12)
    m = np.where((yy % 64) < 1, m * 0.75, m)
    return _shade((0.6, 0.6, 0.62), m)


def tex_tiles(n=256):
    xx, yy = _coords(n)
    m = 0.92 + 0.12 * fbm(n, 13)
    thin = ((xx % 64) < 2) | ((yy % 64) < 2)
    thick = ((xx % 256) < 5) | ((yy % 256) < 5)
    m = np.where(thin, m * 0.7, m)
    m = np.where(thick, m * 0.55, m)
    return _shade((0.7, 0.72, 0.77), m)


def tex_paint(n=128):
    m = 0.85 + 0.25 * fbm(n, 14, (4, 8, 16))
    return _shade((0.9, 0.7, 0.13), m)


def tex_siding(n=256):
    xx, yy = _coords(n)
    m = 0.85 + 0.12 * np.sin(2 * np.pi * xx / 12) + 0.1 * fbm(n, 15)
    m = np.where((xx % 32) < 2, m * 0.6, m)
    rng = np.random.default_rng(16)
    streak = _value_noise(n, 32, rng)[:1, :].repeat(n, 0)
    m *= 1 - 0.18 * np.clip(streak - 0.5, 0, 1) * (yy / n)
    return _shade((0.3, 0.43, 0.47), m)


def tex_windows(n=256):
    xx, yy = _coords(n)
    rng = np.random.default_rng(17)
    rgb = np.zeros((n, n, 3)) + np.array((0.07, 0.08, 0.1))
    cx, cy = xx // 32, yy // 32
    lit = rng.random((n // 32, n // 32))
    bright = rng.random((n // 32, n // 32)) * 0.4 + 0.6
    in_win = ((xx % 32) >= 6) & ((xx % 32) < 26) & ((yy % 32) >= 10) & ((yy % 32) < 24)
    on = lit[cy, cx] < 0.38
    win_on = np.array((0.95, 0.78, 0.48))[None, None, :] * bright[cy, cx][..., None]
    win_off = np.array((0.13, 0.16, 0.21))
    rgb = np.where((in_win & on)[..., None], win_on, rgb)
    rgb = np.where((in_win & ~on)[..., None], win_off, rgb)
    return np.clip(rgb, 0, 1)


def make_image(name, rgb):
    n_y, n_x = rgb.shape[:2]
    img = bpy.data.images.new(name, width=n_x, height=n_y, alpha=False)
    rgba = np.ones((n_y, n_x, 4), dtype=np.float32)
    rgba[..., :3] = rgb
    img.pixels.foreach_set(rgba.ravel())
    path = os.path.join(TEX_DIR, name + '.png')
    img.filepath_raw = path
    img.file_format = 'PNG'
    img.save()
    return img


# ─────────────────────────────────────────────────────────────
# 맵
# ─────────────────────────────────────────────────────────────
# kind → (머티리얼 이름, 텍스처 함수, UV 방식, UV 타일(m), metallic, roughness)
MAP_STYLE = {
    'ground': ('Ground', tex_ground, 'world', 4.0, 0.0, 0.92),
    'wall': ('Wall', tex_concrete_panels, 'world', 4.0, 0.0, 0.85),
    'spawn': ('SpawnWall', tex_metal_panels, 'world', 2.0, 0.45, 0.5),
    'roof': ('Roof', tex_corrugated, 'world', 2.0, 0.4, 0.6),
    'platform': ('Platform', tex_blocks, 'world', 2.0, 0.0, 0.85),
    'stairs': ('Stairs', tex_grating, 'world', 1.0, 0.5, 0.55),
    'cover': ('Cover', tex_cover, 'wallv', 1.2, 0.0, 0.85),
    'crate': ('Crate', tex_crate, 'box', 1.0, 0.2, 0.65),
    'pillar': ('Pillar', tex_concrete, 'world', 2.0, 0.0, 0.85),
    'point': ('PointFloor', tex_tiles, 'world', 2.0, 0.1, 0.6),
    'bridge': ('Bridge', tex_grating, 'world', 1.0, 0.5, 0.55),
    'railing': ('Railing', tex_paint, 'world', 1.0, 0.3, 0.5),
    'building': ('Siding', tex_siding, 'world', 2.0, 0.35, 0.6),
}
FALLBACK_STYLE = ('Wall', tex_concrete_panels, 'world', 4.0, 0.0, 0.85)


def gbox(part, mn, mx, mat, bevel=None):
    """게임 좌표 min/max 박스 → Blender 박스."""
    c = ((mn[0] + mx[0]) / 2, -(mn[2] + mx[2]) / 2, (mn[1] + mx[1]) / 2)
    s = (mx[0] - mn[0], mx[2] - mn[2], mx[1] - mn[1])
    return part.box(c, s, mat, bevel=bevel)


def text_mesh(name, body, size, mat, matrix_world, extrude=0.03):
    cu = bpy.data.curves.new(name + '_curve', 'FONT')
    cu.body = body
    cu.size = size
    cu.extrude = extrude
    cu.align_x = 'CENTER'
    cu.align_y = 'CENTER'
    cu.resolution_u = 2
    tmp = link(bpy.data.objects.new(name + '_tmp', cu))
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(tmp.evaluated_get(dg))
    bpy.data.objects.remove(tmp, do_unlink=True)
    me.materials.clear()
    me.materials.append(mat)
    o = link(bpy.data.objects.new(name, me))
    o.matrix_world = matrix_world
    return o


def build_map(out_dir):
    reset()
    with open(MAP_JSON, encoding='utf-8') as f:
        data = json.load(f)

    cache_img, mats, parts = {}, {}, {}
    for b in data['boxes']:
        kind = b['kind']
        style = MAP_STYLE.get(kind)
        if style is None:
            log('WARN unknown box kind', kind, '- using fallback material')
            style = FALLBACK_STYLE
        mat_name, tex_fn, uv_mode, tile, metallic, rough = style
        if mat_name not in mats:
            if tex_fn.__name__ not in cache_img:
                cache_img[tex_fn.__name__] = make_image('tex_' + tex_fn.__name__[4:], tex_fn())
            mats[mat_name] = make_mat(mat_name, '#ffffff', metallic=metallic, roughness=rough,
                                      image=cache_img[tex_fn.__name__])
        if kind not in parts:
            parts[kind] = Part('map_' + kind, (0, 0, 0), bevel=0.03, uv_mode=uv_mode, uv_tile=tile)
        gbox(parts[kind], b['min'], b['max'], mats[mat_name])
    for p in parts.values():
        p.finish()

    build_map_decor(data)
    export_glb(os.path.join(out_dir, 'map_kestrel.glb'))


def build_map_decor(data):
    paint = make_mat('Paint', '#e8c22a', roughness=0.7)
    lamp = make_mat('Lamp', '#fff4dc', emission='#fff1d6', strength=4.0)
    sign = make_mat('Sign', '#ece7da', roughness=0.6)
    girder = make_mat('Girder', '#3c4148', metallic=0.7, roughness=0.45)
    pointmark = make_mat('PointMark', '#eef2f6', roughness=0.5, emission='#dfe8f0', strength=0.35)
    padmark = make_mat('PadMark', '#3fbf74', roughness=0.5, emission='#3fbf74', strength=0.8)
    emblem = make_mat('Emblem', '#f4f6f8', roughness=0.5, emission='#ffffff', strength=0.4)
    banners = [make_mat('BannerBlue', TEAM_COLORS[0], roughness=0.7, emission=TEAM_COLORS[0], strength=0.35),
               make_mat('BannerRed', TEAM_COLORS[1], roughness=0.7, emission=TEAM_COLORS[1], strength=0.35)]
    crane_mat = make_mat('Crane', '#c9a227', metallic=0.4, roughness=0.55)
    sky_img = make_image('tex_windows', tex_windows())
    skyline = make_mat('Skyline', '#ffffff', roughness=0.8, image=sky_img, emission_image=True, strength=1.2)

    # 1) 바닥 차선 페인트(두께 1.2cm)
    lanes = Part('decor_surf_paint', bevel=0)
    for z in (-11.0, 11.0):
        x = -30.0
        while x < 30.0:
            x1 = min(x + 2.0, 30.0)
            if not (-6.5 < (x + x1) / 2 < 6.5):
                gbox(lanes, (x, 0, z - 0.08), (x1, 0.012, z + 0.08), paint, bevel=0)
            x += 3.0
    for sgn in (-1, 1):  # 스폰 출입문 앞 경고 띠
        x_face = 31 * sgn
        for z0, z1 in ((-6.5, -2.5), (2.5, 6.5)):
            for k in range(4):
                xa = x_face - sgn * (0.6 + k * 0.5)
                gbox(lanes, (min(xa, xa - sgn * 0.25), 0, z0), (max(xa, xa - sgn * 0.25), 0.012, z1), paint, bevel=0)
    lanes.finish()

    # 2) 스폰 출입벽 배너 + 엠블럼(사선 균열 모양 — Riftline 고유 문양)
    for team, sgn in ((0, -1), (1, 1)):
        bn = Part(f'decor_surf_banner_{"blue" if team == 0 else "red"}', bevel=0)
        face = 31 * sgn          # 스폰 앞벽 바깥면 x=±31
        x0, x1 = sorted((face, face - sgn * 0.05))   # 아레나 쪽(중앙 방향)으로 돌출
        gbox(bn, (x0, 0.8, -1.6), (x1, 4.6, 1.6), banners[team], bevel=0)
        e0, e1 = sorted((face - sgn * 0.05, face - sgn * 0.08))
        cx = (e0 + e1) / 2
        bn.box((cx, 0, 2.9), (e1 - e0, 0.22, 2.4), emblem, rot=(28, 0, 0), bevel=0)
        bn.box((cx, -0.55, 2.2), (e1 - e0, 0.14, 0.9), emblem, rot=(28, 0, 0), bevel=0)
        bn.box((cx, 0.55, 3.6), (e1 - e0, 0.14, 0.9), emblem, rot=(28, 0, 0), bevel=0)
        bn.finish()
        # 스폰 구역 바닥 테두리(팀 색)
        sz = data['spawnZones'][team]
        mn, mx = sz['min'], sz['max']
        border = Part(f'decor_surf_spawnline_{team}', bevel=0)
        inset = 0.6
        ax0, ax1 = mn[0] + inset, mx[0] - inset
        az0, az1 = mn[2] + inset, mx[2] - inset
        w = 0.12
        gbox(border, (ax0, 0, az0), (ax1, 0.012, az0 + w), banners[team], bevel=0)
        gbox(border, (ax0, 0, az1 - w), (ax1, 0.012, az1), banners[team], bevel=0)
        gbox(border, (ax0, 0, az0), (ax0 + w, 0.012, az1), banners[team], bevel=0)
        gbox(border, (ax1 - w, 0, az0), (ax1, 0.012, az1), banners[team], bevel=0)
        border.finish()

    # 3) 외벽 조명(벽면에서 0.12m 돌출)
    for name, axis, face, sgn, rng_ in (('n', 'z', 26, -1, range(-40, 41, 8)), ('s', 'z', -26, 1, range(-40, 41, 8)),
                                        ('w', 'x', -43, 1, range(-24, 25, 8)), ('e', 'x', 43, -1, range(-24, 25, 8))):
        lp = Part(f'decor_surf_lamps_{name}', bevel=0)
        a0, a1 = sorted((face, face + sgn * 0.12))
        for t in rng_:
            if axis == 'z':
                gbox(lp, (t - 0.35, 6.0, a0), (t + 0.35, 6.25, a1), lamp, bevel=0)
            else:
                gbox(lp, (a0, 6.0, t - 0.35), (a1, 6.25, t + 0.35), lamp, bevel=0)
        lp.finish()

    # 4) 북·남 외벽 사인(글자 두께 0.06m)
    # 북벽 안쪽 면: 게임 z=26, Blender Y=-26, 아레나 쪽(+Y)을 향하게.
    m_n = Matrix.Translation((0, -26 + 0.035, 7.4)) @ Euler((math.radians(90), 0, math.radians(180)), 'XYZ').to_matrix().to_4x4()
    text_mesh('decor_surf_sign_n', 'KESTREL YARD', 1.6, sign, m_n)
    # 남벽 안쪽 면: 게임 z=-26, Blender Y=26, -Y 를 향하게.
    m_s = Matrix.Translation((0, 26 - 0.035, 7.4)) @ Euler((math.radians(90), 0, 0), 'XYZ').to_matrix().to_4x4()
    text_mesh('decor_surf_sign_s', 'RIFTLINE  //  SECTOR 7', 1.1, sign, m_s)

    # 5) 거점 마킹(반지름 5m 고리 + 안쪽 육각 고리)
    pt = data['point']
    px, py, pz = pt['pos']
    mark = Part('decor_surf_point', bevel=0)
    mark.ring_solid((px, -pz), pt['radius'] - 0.25, pt['radius'], py, py + 0.012, pointmark, segs=64)
    mark.ring_solid((px, -pz), 1.1, 1.3, py, py + 0.012, pointmark, segs=6)
    mark.finish()

    # 6) 회복 팩 받침 마킹
    levels = {}   # 높이(바닥면)별로 노드를 나눠 각 노드가 얇은 판이 되게 한다
    for hp in data['healthPacks']:
        x, y, z = hp['pos']
        pads = levels.setdefault(y, Part(f'decor_surf_pads_{len(levels)}', bevel=0))
        r = 0.55 if hp['size'] == 'large' else 0.42
        pads.ring_solid((x, -z), r - 0.08, r, y, y + 0.012, padmark, segs=24)
    for pads in levels.values():
        pads.finish()

    # 7) 다리 밑 거더(아래로 0.15m, 통과 높이 2.45m 유지)
    gd = Part('decor_surf_girders', bevel=0.01)
    for b in data['boxes']:
        if b['kind'] != 'bridge':
            continue
        (x0, y0, z0), (x1, _, z1) = b['min'], b['max']
        for zz in (z0 + 0.35, z1 - 0.35):
            gbox(gd, (x0, y0 - 0.15, zz - 0.1), (x1, y0, zz + 0.1), girder)
        xx = x0 + 1.75
        while xx < x1 - 0.5:
            gbox(gd, (xx - 0.08, y0 - 0.12, z0 + 0.1), (xx + 0.08, y0, z1 - 0.1), girder)
            xx += 3.5
    gd.finish()

    # 8) 창고 천장등(지붕 아래 0.1m)
    wl = Part('decor_surf_ceiling', bevel=0)
    for b in data['boxes']:
        if b['kind'] == 'roof' and b['min'][1] < 5:   # 창고 지붕(y=4.5)만
            (x0, y0, z0), (x1, _, z1) = b['min'], b['max']
            cx, cz = (x0 + x1) / 2, (z0 + z1) / 2
            gbox(wl, (cx - 2.5, y0 - 0.1, cz - 0.25), (cx + 2.5, y0, cz + 0.25), lamp, bevel=0)
    wl.finish()

    # 9) 외벽 바깥 원경(건물·크레인) — 플레이 공간과 겹치지 않음
    rng = np.random.default_rng(42)
    # 체크 스크립트가 노드별 바운딩으로 플레이 공간과의 겹침을 검사하므로 방향별로 나눈다.
    skies = [Part(f'decor_out_skyline_{d}', bevel=0, uv_mode='world', uv_tile=16.0) for d in 'nswe']
    for i in range(18):
        side = i % 4
        t = rng.uniform(-80, 80)
        w, d, h = rng.uniform(8, 18), rng.uniform(8, 16), rng.uniform(18, 46)
        dist = rng.uniform(36, 70)
        if side == 0:
            cx, cz = t, dist
        elif side == 1:
            cx, cz = t, -dist
        elif side == 2:
            cx, cz = -(dist + 18), t * 0.5
        else:
            cx, cz = dist + 18, t * 0.5
        gbox(skies[side], (cx - w / 2, -2, cz - d / 2), (cx + w / 2, h, cz + d / 2), skyline, bevel=0)
    for sky in skies:
        sky.finish()
    for ci, (cx, cz) in enumerate(((30, 40), (-34, -42))):
        cr = Part(f'decor_out_crane_{ci}', bevel=0.02)
        for lx in (-6, 6):
            for lz in (-3, 3):
                gbox(cr, (cx + lx - 0.5, -2, cz + lz - 0.5), (cx + lx + 0.5, 30, cz + lz + 0.5), crane_mat)
        for rz in (-3.0, 3.0):   # 갠트리 레일 두 줄 + 가로대 + 트롤리
            gbox(cr, (cx - 14, 30, cz + rz - 0.5), (cx + 14, 31.4, cz + rz + 0.5), crane_mat)
        for lx in (-13, -6, 0, 6, 13):
            gbox(cr, (cx + lx - 0.3, 30.2, cz - 3), (cx + lx + 0.3, 31.0, cz + 3), crane_mat)
        gbox(cr, (cx - 3.5, 28.5, cz - 2.2), (cx - 0.5, 30.2, cz + 2.2), crane_mat)
        gbox(cr, (cx - 2.2, 16, cz - 0.04), (cx - 1.8, 28.5, cz + 0.04), crane_mat)
        for lx in (-6, 6):
            gbox(cr, (cx + lx - 0.4, 12, cz - 3), (cx + lx + 0.4, 12.8, cz + 3), crane_mat)
        cr.finish()


# ─────────────────────────────────────────────────────────────
# 소품
# ─────────────────────────────────────────────────────────────
def build_props(out_dir):
    vex, ember, rook = HEROES['vex'], HEROES['ember'], HEROES['rook']

    reset()
    D = make_mat('Dark', '#25282e', metallic=0.5, roughness=0.5)
    G = make_mat('Glow', vex['accent'], emission=vex['accent'], strength=3.5)
    T = make_mat('Team', '#e8e8e8', emission='#ffffff', strength=0.6)
    A = make_mat('Accent', vex['primary'], metallic=0.3, roughness=0.4)
    m = Part('mine', bevel=0.008)
    m.frustum((0, 0, 0), (0, 0, 0.06), 0.22, 0.2, D, segs=14)
    m.sphere((0, 0, 0.06), 0.12, G, scale=(1, 1, 0.45), segs=12, rings=6)
    m.frustum((0, 0, 0.058), (0, 0, 0.066), 0.205, 0.205, T, segs=14)
    for k in range(3):
        a = 2 * math.pi * k / 3
        m.box((0.2 * math.cos(a), 0.2 * math.sin(a), 0.04), (0.07, 0.07, 0.05), A, rot=(0, 0, math.degrees(a)))
    m.finish()
    export_glb(os.path.join(out_dir, 'prop_mine.glb'))

    reset()
    P = make_mat('Primary', rook['primary'], metallic=0.3, roughness=0.5)
    D = make_mat('Dark', '#25282e', metallic=0.5, roughness=0.5)
    Mt = make_mat('Metal', '#8b929b', metallic=0.85, roughness=0.3)
    G = make_mat('Glow', rook['accent'], emission=rook['accent'], strength=3.5)
    T = make_mat('Team', '#e8e8e8', emission='#ffffff', strength=0.6)
    base = Part('turret', bevel=0.008)
    for k in range(3):
        a = 2 * math.pi * k / 3 + math.pi / 2
        base.beam((0, 0, 0.45), (0.36 * math.cos(a), 0.36 * math.sin(a), 0.0), 0.045, 0.045, D)
        base.box((0.36 * math.cos(a), 0.36 * math.sin(a), 0.015), (0.08, 0.08, 0.03), Mt)
    base.frustum((0, 0, 0.4), (0, 0, 0.62), 0.05, 0.045, Mt, segs=10)
    base.frustum((0, 0, 0.42), (0, 0, 0.5), 0.09, 0.08, D, segs=10)
    head = Part('head', (0, 0, 0.72), bevel=0.008)
    head.sphere((0, 0, 0.72), 0.17, P, scale=(1, 1.2, 0.85), segs=14, rings=8)
    head.frustum((0, 0, 0.70), (0, 0, 0.74), 0.176, 0.176, T, segs=14)
    for bx in (-0.05, 0.05):
        head.frustum((bx, 0.15, 0.71), (bx, 0.42, 0.71), 0.025, 0.025, Mt, segs=8)
    head.sphere((0, 0.17, 0.78), 0.04, G, segs=8, rings=5)
    head.beam((-0.08, -0.1, 0.84), (-0.1, -0.14, 0.95), 0.012, 0.012, Mt)
    to = base.finish()
    ho = head.finish(to, (0, 0, 0))
    new_empty('muzzle', Vector((0, 0.43, 0.71)) - head.joint, parent=ho)
    export_glb(os.path.join(out_dir, 'prop_turret.glb'))

    reset()
    A = make_mat('Accent', ember['accent'], metallic=0.3, roughness=0.45)
    D = make_mat('Dark', '#25282e', metallic=0.5, roughness=0.5)
    G = make_mat('Glow', '#ffcf6a', emission='#ff9a2e', strength=4.0)
    c = Part('canister', bevel=0.006)
    c.frustum((0, 0, -0.14), (0, 0, 0.14), 0.085, 0.085, A, segs=12)
    for z0, z1 in ((-0.17, -0.14), (0.14, 0.17)):
        c.frustum((0, 0, z0), (0, 0, z1), 0.095, 0.095, D, segs=12)
    c.box((0, 0.086, 0), (0.05, 0.012, 0.18), G)
    c.box((0, -0.086, 0), (0.05, 0.012, 0.18), G)
    c.finish()
    export_glb(os.path.join(out_dir, 'prop_canister.glb'))

    for size, (w, h, plus) in (('small', (0.5, 0.34, 0.32)), ('large', (0.7, 0.44, 0.46))):
        reset()
        base_m = make_mat('Pack', '#2e9e5b', metallic=0.1, roughness=0.5)
        mark = make_mat('Mark', '#ffffff', roughness=0.4, emission='#ffffff', strength=0.6)
        trim = make_mat('Dark', '#25282e', metallic=0.4, roughness=0.5)
        hp = Part('healthpack', bevel=0.02)
        hp.box((0, 0, h / 2), (w, w, h), base_m)
        hp.box((0, 0, 0.03), (w + 0.02, w + 0.02, 0.06), trim)
        hp.box((0, 0, h + 0.006), (plus, plus * 0.28, 0.012), mark, bevel=0)
        hp.box((0, 0, h + 0.006), (plus * 0.28, plus, 0.012), mark, bevel=0)
        for ax, sgn in (('x', 1), ('x', -1), ('y', 1), ('y', -1)):
            off = w / 2 + 0.006
            p = plus * 0.6
            if ax == 'x':
                hp.box((sgn * off, 0, h / 2), (0.012, p, p * 0.28), mark, bevel=0)
                hp.box((sgn * off, 0, h / 2), (0.012, p * 0.28, p), mark, bevel=0)
            else:
                hp.box((0, sgn * off, h / 2), (p, 0.012, p * 0.28), mark, bevel=0)
                hp.box((0, sgn * off, h / 2), (p * 0.28, 0.012, p), mark, bevel=0)
        hp.finish()
        export_glb(os.path.join(out_dir, f'prop_healthpack_{size}.glb'))


# ─────────────────────────────────────────────────────────────
# 미리보기 렌더(내보낸 GLB 를 다시 불러와서 렌더 → 게임이 보는 결과 그대로 확인)
# ─────────────────────────────────────────────────────────────
def import_glb(path, offset=(0, 0, 0), rot_z=0.0):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    for o in new:
        if o.parent is None:
            o.location = Vector(o.location) + Vector(offset)
            o.rotation_mode = 'XYZ'
            o.rotation_euler.z += rot_z
    return new


def setup_render(res, ortho=None, cam_loc=(0, 0, 0), target=(0, 0, 0), lens=50, sun=(50, 0, 30),
                 floor=True, bg=(0.55, 0.62, 0.72)):
    s = bpy.context.scene
    s.render.engine = 'BLENDER_EEVEE'
    s.render.resolution_x, s.render.resolution_y = res
    s.render.resolution_percentage = 100
    s.render.film_transparent = False
    if hasattr(s, 'eevee'):
        s.eevee.taa_render_samples = 32
    s.view_settings.view_transform = 'Standard'
    world = s.world or bpy.data.worlds.new('World')
    s.world = world
    if world.node_tree is None:
        world.use_nodes = True
    bgn = next(n for n in world.node_tree.nodes if n.type == 'BACKGROUND')
    bgn.inputs['Color'].default_value = (*bg, 1)
    bgn.inputs['Strength'].default_value = 0.9
    cam_data = bpy.data.cameras.new('cam')
    if ortho:
        cam_data.type = 'ORTHO'
        cam_data.ortho_scale = ortho
    else:
        cam_data.lens = lens
    cam_data.clip_end = 1000
    cam = link(bpy.data.objects.new('cam', cam_data))
    cam.location = cam_loc
    cam.rotation_euler = (Vector(target) - Vector(cam_loc)).to_track_quat('-Z', 'Y').to_euler()
    s.camera = cam
    sd = bpy.data.lights.new('sun', 'SUN')
    sd.energy = 3.5
    sd.angle = math.radians(3)
    so = link(bpy.data.objects.new('sun', sd))
    so.rotation_euler = tuple(math.radians(a) for a in sun)
    if floor:
        me = bpy.data.meshes.new('floor')
        bm = bmesh.new()
        bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=40)
        bm.to_mesh(me)
        bm.free()
        me.materials.append(make_mat('PreviewFloor', '#7d828a', roughness=0.9))
        link(bpy.data.objects.new('floor', me))


def render_to(path):
    s = bpy.context.scene
    s.render.filepath = path
    bpy.ops.render.render(write_still=True)
    log('preview', os.path.relpath(path, ROOT))


def render_previews(model_dir, prev_dir):
    os.makedirs(prev_dir, exist_ok=True)
    ids = list(HEROES)
    spacing = 1.9

    # 정면(정사영): 실루엣 구분·발 높이 확인
    reset()
    for i, hid in enumerate(ids):
        import_glb(os.path.join(model_dir, f'hero_{hid}.glb'), ((i - 2) * spacing, 0, 0))
    setup_render((1800, 760), ortho=10.2, cam_loc=(0, 12, 1.1), target=(0, 0, 1.1), sun=(55, 0, 160))
    render_to(os.path.join(prev_dir, 'heroes_front.png'))

    # 측면(정사영, 앞=+Y 가 화면 오른쪽): 무기 방향·총구 확인
    reset()
    for i, hid in enumerate(ids):
        import_glb(os.path.join(model_dir, f'hero_{hid}.glb'), (0, (i - 2) * 2.6, 0))
    setup_render((1900, 620), ortho=13.5, cam_loc=(12, 0, 1.1), target=(0, 0, 1.1), sun=(55, 0, 60))
    render_to(os.path.join(prev_dir, 'heroes_side.png'))

    # 3/4 원근
    reset()
    for i, hid in enumerate(ids):
        import_glb(os.path.join(model_dir, f'hero_{hid}.glb'), ((i - 2) * 1.6, -abs(i - 2) * 0.5, 0), rot_z=math.radians(-25))
    setup_render((1600, 900), cam_loc=(4.5, 9.5, 3.0), target=(0, 0, 1.0), lens=45, sun=(50, 0, 140))
    render_to(os.path.join(prev_dir, 'heroes_34.png'))

    # 1인칭 무기
    reset()
    for i, hid in enumerate(ids):
        import_glb(os.path.join(model_dir, f'weapon_{hid}.glb'), ((i - 2) * 1.1, 0, 1.0))
    setup_render((1800, 650), cam_loc=(1.2, -5.5, 3.6), target=(0, 0.4, 1.0), lens=32, sun=(50, 0, 140))
    render_to(os.path.join(prev_dir, 'weapons.png'))

    # 소품
    reset()
    for i, name in enumerate(('mine', 'turret', 'canister', 'healthpack_small', 'healthpack_large')):
        import_glb(os.path.join(model_dir, f'prop_{name}.glb'), ((i - 2) * 1.0, 0, 0.17 if name == 'canister' else 0))
    setup_render((1600, 520), cam_loc=(0, 7.0, 2.2), target=(0, 0, 0.35), lens=45, sun=(50, 0, 150))
    render_to(os.path.join(prev_dir, 'props.png'))

    # 맵 조감 + 정사영 평면도
    reset()
    import_glb(os.path.join(model_dir, 'map_kestrel.glb'))
    setup_render((1800, 1100), cam_loc=(-10, 62, 46), target=(0, -2, 0), lens=24, sun=(48, 0, 35),
                 floor=False, bg=(0.6, 0.7, 0.82))
    render_to(os.path.join(prev_dir, 'map_aerial.png'))
    s = bpy.context.scene
    s.camera.data.type = 'ORTHO'
    s.camera.data.ortho_scale = 92
    s.camera.location = (0, 0, 120)
    s.camera.rotation_euler = (0, 0, 0)
    s.render.resolution_x, s.render.resolution_y = 1800, 1150
    render_to(os.path.join(prev_dir, 'map_top.png'))

    # 지상 시점(청색 팀 스폰 앞에서 거점 쪽)
    s.camera.data.type = 'PERSP'
    s.camera.data.lens = 22
    s.camera.location = (-28, 0, 1.7)
    s.camera.rotation_euler = (Vector((0, 0, 1.2)) - Vector((-28, 0, 1.7))).to_track_quat('-Z', 'Y').to_euler()
    s.render.resolution_x, s.render.resolution_y = 1600, 900
    render_to(os.path.join(prev_dir, 'map_ground.png'))


# ─────────────────────────────────────────────────────────────
def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(ROOT, 'assets', 'models'))
    ap.add_argument('--previews', default=None)
    ap.add_argument('--only', default='heroes,weapons,map,props')
    args = ap.parse_args(argv)
    out = os.path.abspath(args.out)
    only = set(args.only.split(','))
    t0 = time.time()
    if 'heroes' in only:
        for hid in HEROES:
            build_hero(hid, out)
    if 'weapons' in only:
        for hid in HEROES:
            build_fp_weapon(hid, out)
    if 'map' in only:
        build_map(out)
    if 'props' in only:
        build_props(out)
    if args.previews:
        render_previews(out, os.path.abspath(args.previews))
    log(f'done in {time.time() - t0:.1f}s')


main()
