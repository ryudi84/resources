#!/usr/bin/env python3
"""Draw the holder-link graph from a token-forensics JSON report.

    python3 holder_graph.py investigations/SYMBOL-mint8.json out.svg [--title "…"]

Then render:  chrome --headless=new --no-sandbox --hide-scrollbars \
              --force-device-scale-factor=2 --window-size=W,H --screenshot=out.png out.html
(the script also writes out.html next to the svg, with the page size in the file name comment).

Layout: wallets connected to the creator or to each other by token transfers / funding form
the "linked network" (left, blue, force-directed-ish grid); remaining top holders are grouped
by class (launch snipers, automated, independent) in columns to the right. Node size = share
of supply; hollow = holds nothing today (pass-through / funder). Solid arrows = token
transfers, dashed = SOL funding. Colours come from the dataviz reference palette and pass its
validator (blue, orange, aqua; neutral gray for pool/retail).
"""
import json, math, sys, re
from collections import defaultdict

BLUE, ORANGE, AQUA, GRAY = '#2a78d6', '#eb6834', '#1baf7a', '#9a9994'
INK, INK2, SURF = '#0b0b0b', '#52514e', '#fcfcfb'
COL_W, ROW_H, MARGIN = 230, 135, 40

def short(a): return f'{a[:4]}…{a[-4:]}' if a and len(a) > 12 else (a or '')
def radius(p): return 14 + 9 * math.sqrt(max(p, 0.3))
def fmt_amt(v): return f'{v/1e6:.1f}M' if v >= 1e6 else f'{v/1e3:.0f}k' if v >= 1e3 else f'{v:.0f}'

def build(d):
    holders = {h['owner']: h for h in d['holders']}
    creator = (d.get('creator') or {}).get('address') or (d.get('pump') or {}).get('creator')
    supply = None
    for h in d['holders']:
        if h.get('pct') and h.get('amount'):
            supply = h['amount'] / (h['pct'] / 100); break
    edges = []  # (from, to, label, kind)
    def T(a, b, amt, when=None):
        lab = fmt_amt(amt)
        if supply and amt / supply > 0.005: lab = f'{amt/supply*100:.1f}%' + (f' · {when[5:10]}' if when else '')
        edges.append((a, b, lab, 't'))
    cp = (d.get('creator') or {}).get('provenance')
    if creator and cp:
        for t in cp.get('transfersOut', []):
            if t.get('to') and t['to'] != '?': T(creator, t['to'], t['amount'], iso(t.get('time')))
        for t in cp.get('transfersIn', []):
            if t.get('from') and t['from'] != '?': T(t['from'], creator, t['amount'], iso(t.get('time')))
    for h in d['holders']:
        p = h.get('provenance')
        if not p: continue
        for t in p.get('transfersIn', []):
            if t.get('from') and t['from'] != '?': T(t['from'], h['owner'], t['amount'], iso(t.get('time')))
        for t in p.get('transfersOut', []):
            if t.get('to') and t['to'] != '?': T(h['owner'], t['to'], t['amount'], iso(t.get('time')))
    for b in d.get('bundleDestinations') or []:
        p = b.get('prov')
        if p:
            for t in p.get('transfersOut', []):
                if t.get('to') and t['to'] != '?': T(b['wallet'], t['to'], t['amount'], iso(t.get('time')))
    # funding edges: shared funders (clusters) and funders that are creator/holders
    byf = defaultdict(list)
    for h in d['holders']:
        if h.get('funder') and not h.get('funderCex'): byf[h['funder']].append(h['owner'])
    for f, ws in byf.items():
        if len(ws) >= 2 or f == creator or f in holders:
            for w in ws: edges.append((f, w, 'funds', 'f'))
    for f, hop in (d.get('funderHops') or {}).items():
        if hop.get('funder') and (hop['funder'] == creator or hop['funder'] in holders or hop['funder'] in byf):
            edges.append((hop['funder'], f, 'funds', 'f'))
    # dedupe
    seen = set(); out = []
    for e in edges:
        k = (e[0], e[1], e[3])
        if k not in seen and e[0] != e[1]: seen.add(k); out.append(e)
    return holders, creator, out, supply

def iso(t):
    if not t: return None
    import datetime as dt
    return dt.datetime.utcfromtimestamp(t).strftime('%Y-%m-%d')

def components(nodes, edges):
    parent = {n: n for n in nodes}
    def find(x):
        while parent[x] != x: parent[x] = parent[parent[x]]; x = parent[x]
        return x
    for a, b, _, _ in edges:
        if a in parent and b in parent: parent[find(a)] = find(b)
    comp = defaultdict(list)
    for n in nodes: comp[find(n)].append(n)
    return list(comp.values())

def layout(d):
    holders, creator, edges, supply = build(d)
    nodes = set(holders) | {e[0] for e in edges} | {e[1] for e in edges}
    if creator: nodes.add(creator)
    pool_owners = {o for o, h in holders.items() if h.get('verdict') == 'pool'}
    nodes -= pool_owners
    comps = components(nodes, edges)
    # A component is a "linked network" only if it ties the creator or ≥2 balance holders
    # together; a holder plus one pass-through wallet is not a network.
    def is_linked(c):
        return (creator in c) or sum(1 for n in c if holders.get(n, {}).get('pct', 0) > 0) >= 2
    linked = [c for c in comps if len(c) >= 2 and is_linked(c)]
    linked.sort(key=lambda c: -sum(holders.get(n, {}).get('pct', 0) for n in c))
    linked_nodes = {n for c in linked for n in c}
    singles = [n for n in holders if n not in linked_nodes and n not in pool_owners and holders[n].get('pct', 0) > 0]
    edges = [e for e in edges if e[0] in linked_nodes and e[1] in linked_nodes]
    def cls(w):
        h = holders.get(w, {})
        if h.get('launchBuyer') or h.get('bundled'): return 'sniper'
        if h.get('txCountCapped'): return 'auto'
        return 'indep'
    groups = {'sniper': [], 'auto': [], 'indep': []}
    for w in singles: groups[cls(w)].append(w)
    for g in groups.values(): g.sort(key=lambda w: -holders[w]['pct'])
    pos, color = {}, {}
    # linked network: BFS layers from creator / largest holder, grid columns
    x0 = MARGIN + 20; y = MARGIN + 70; maxx = x0
    for comp in linked:
        root = creator if creator in comp else max(comp, key=lambda n: holders.get(n, {}).get('pct', 0))
        adj = defaultdict(set)
        for a, b, _, _ in edges:
            if a in comp and b in comp: adj[a].add(b); adj[b].add(a)
        layer = {root: 0}; q = [root]
        while q:
            n = q.pop(0)
            for m in adj[n]:
                if m not in layer: layer[m] = layer[n] + 1; q.append(m)
        for n in comp: layer.setdefault(n, 0)
        cols = defaultdict(list)
        for n, l in layer.items(): cols[l].append(n)
        h_max = 0
        for l, ns in cols.items():
            ns.sort(key=lambda n: -holders.get(n, {}).get('pct', 0))
            for i, n in enumerate(ns):
                pos[n] = (x0 + l * COL_W, y + i * ROW_H); color[n] = BLUE
            h_max = max(h_max, len(ns))
            maxx = max(maxx, x0 + l * COL_W)
        y += h_max * ROW_H + 40
    left_w = maxx + 160
    left_h = max(y, 400)
    # single groups in columns to the right
    gx = left_w + 60
    titles = {'sniper': ('Launch snipers', ORANGE), 'auto': ('Automated', ORANGE), 'indep': ('Independent', AQUA)}
    panels = [('Linked network', BLUE, MARGIN, MARGIN, left_w - MARGIN, left_h - MARGIN + 40)]
    for key in ('sniper', 'auto', 'indep'):
        ws = groups[key]
        if not ws: continue
        title, c = titles[key]
        for i, w in enumerate(ws[:9]):
            pos[w] = (gx + 130, MARGIN + 100 + i * 100); color[w] = c
        panels.append((title, c, gx, MARGIN, 260, max(220, 100 + min(len(ws), 9) * 100 + 40)))
        gx += 300
    W = gx + MARGIN; H = max(left_h + 120, MARGIN + 100 + 9 * 100 + 80)
    return holders, creator, edges, pos, color, panels, groups, W, H

def render(d, title):
    holders, creator, edges, pos, color, panels, groups, W, H = layout(d)
    svg = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" font-family="Inter, Helvetica, Arial, sans-serif">',
           f'<rect width="{W}" height="{H}" fill="{SURF}"/>',
           '<defs>' + ''.join(f'<marker id="m{i}" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="{c}"/></marker>' for i, c in enumerate([BLUE, ORANGE, AQUA, INK2])) + '</defs>']
    mid = {BLUE: 'm0', ORANGE: 'm1', AQUA: 'm2', INK2: 'm3'}
    svg.append(f'<text x="{MARGIN}" y="{MARGIN - 12}" font-size="18" font-weight="700" fill="{INK}">{title}</text>')
    for t, c, x, y, w, h in panels:
        share = sum(holders.get(n, {}).get('pct', 0) for n, (px, py) in pos.items() if x <= px <= x + w and y <= py <= y + h)
        svg.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="14" fill="none" stroke="{c}" stroke-opacity="0.35" stroke-width="1.5"/><text x="{x+16}" y="{y+26}" font-size="15" font-weight="700" fill="{INK}">{t} · {share:.1f}% of supply</text>')
    pairs = {(a, b) for a, b, _, _ in edges}
    for a, b, lab, kind in edges:
        if a not in pos or b not in pos: continue
        (x1, y1), (x2, y2) = pos[a], pos[b]
        ra, rb = radius(holders.get(a, {}).get('pct', 0)), radius(holders.get(b, {}).get('pct', 0))
        dx, dy = x2 - x1, y2 - y1; dd = math.hypot(dx, dy) or 1; ux, uy = dx / dd, dy / dd
        off = 9 if (b, a) in pairs else 0; px, py = -uy * off, ux * off
        sx, sy, ex, ey = x1 + ux * ra + px, y1 + uy * ra + py, x2 - ux * (rb + 3) + px, y2 - uy * (rb + 3) + py
        c = color.get(a, BLUE) if kind == 't' else INK2
        dash = '' if kind == 't' else ' stroke-dasharray="6 5"'
        svg.append(f'<line x1="{sx:.0f}" y1="{sy:.0f}" x2="{ex:.0f}" y2="{ey:.0f}" stroke="{c}" stroke-width="2"{dash} marker-end="url(#{mid[c]})"/>')
        mx, my = (sx + ex) / 2 + px * 1.4, (sy + ey) / 2 + py * 1.4
        svg.append(f'<rect x="{mx-len(lab)*3.4-4:.0f}" y="{my-9:.0f}" width="{len(lab)*6.8+8:.0f}" height="16" rx="3" fill="{SURF}" fill-opacity="0.92"/><text x="{mx:.0f}" y="{my+4:.0f}" text-anchor="middle" font-size="11" fill="{INK2}">{lab}</text>')
    for n, (x, y) in pos.items():
        h = holders.get(n, {}); p = h.get('pct', 0); c = color.get(n, BLUE); rr = radius(p)
        svg.append(f'<circle cx="{x}" cy="{y}" r="{rr}" fill="{c if p > 0 else SURF}" fill-opacity="{0.9 if p > 0 else 1}" stroke="{SURF if p > 0 else c}" stroke-width="{2 if p > 0 else 2.5}"/>')
        name = 'CREATOR' if n == creator else short(n)
        svg.append(f'<text x="{x}" y="{y+rr+15}" text-anchor="middle" font-size="12" font-weight="700" fill="{INK}">{name}</text>')
        reason = (h.get('reasons') or [''])[0]
        reason = re.sub(r'\(.*?\)', '', reason).strip()[:26]
        sub = (f'{p:.2f}%' if p > 0 else '') + (f'  {reason}' if reason and p > 0 else '')
        if sub: svg.append(f'<text x="{x}" y="{y+rr+29}" text-anchor="middle" font-size="10.5" fill="{INK2}">{sub}</text>')
    lx, ly = MARGIN + 16, H - 70
    svg.append(f'<circle cx="{lx+8}" cy="{ly}" r="8" fill="{BLUE}"/><text x="{lx+24}" y="{ly+4}" font-size="12" fill="{INK2}">filled = holds tokens, size = share</text>'
               f'<circle cx="{lx+300}" cy="{ly}" r="8" fill="{SURF}" stroke="{BLUE}" stroke-width="2.5"/><text x="{lx+316}" y="{ly+4}" font-size="12" fill="{INK2}">hollow = pass-through / funder</text>'
               f'<line x1="{lx+560}" y1="{ly}" x2="{lx+576}" y2="{ly}" stroke="{BLUE}" stroke-width="2" marker-end="url(#m0)"/><text x="{lx+584}" y="{ly+4}" font-size="12" fill="{INK2}">token transfer</text>'
               f'<line x1="{lx+700}" y1="{ly}" x2="{lx+716}" y2="{ly}" stroke="{INK2}" stroke-width="2" stroke-dasharray="6 5" marker-end="url(#m3)"/><text x="{lx+724}" y="{ly+4}" font-size="12" fill="{INK2}">SOL funding</text>')
    svg.append('</svg>')
    return '\n'.join(svg), W, H

if __name__ == '__main__':
    src, out = sys.argv[1], sys.argv[2]
    d = json.load(open(src))
    title = f"{d.get('name', '?')} (${d.get('symbol', '?')}) holder links · {d.get('generatedAt', '')[:10]}"
    for i, a in enumerate(sys.argv):
        if a == '--title': title = sys.argv[i + 1]
    svg, W, H = render(d, title)
    open(out, 'w').write(svg)
    html = out.rsplit('.', 1)[0] + '.html'
    open(html, 'w').write(f'<!-- window-size={W},{H} --><html><body style="margin:0;background:{SURF}">{svg}</body></html>')
    print(f'wrote {out} and {html}; render with --window-size={W},{H}')
