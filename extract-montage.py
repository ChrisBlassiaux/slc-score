#!/usr/bin/env python3
"""
Extrait le montage d'affichage NOX depuis Data.ndb -> workspace_workspace
(sérialisation binaire .NET / MS-NRBF).

Pour chaque feuille ("Respi PSG", "Neuro", "Signaux EEG unipolaires") : fenêtre,
demi-pas, et la liste ordonnée des canaux avec, par canal :
  label, type NOX, couleur, ordre vertical, bornes d'axe Y + verrouillage,
  passe-haut (_lff) / passe-bas (_hff), inversion, filtres (50 Hz, ECG-adaptatif, frontal).

Sortie : montage.json  +  résumé console.
Usage  : python3 extract-montage.py
"""
import os, sqlite3, struct, json, re

BASE = os.path.dirname(os.path.abspath(__file__))
STUDY = next(x for x in os.listdir(BASE) if x.startswith("ZAM"))
NDB = os.path.join(BASE, STUDY, "Data.ndb")


class Reader:
    def __init__(self, buf):
        self.b = buf
        self.p = 0
        self.objects = {}
        self.classes = {}

    def u8(self):
        v = self.b[self.p]; self.p += 1; return v

    def i16(self):
        v = struct.unpack_from("<h", self.b, self.p)[0]; self.p += 2; return v

    def i32(self):
        v = struct.unpack_from("<i", self.b, self.p)[0]; self.p += 4; return v

    def i64(self):
        v = struct.unpack_from("<q", self.b, self.p)[0]; self.p += 8; return v

    def f32(self):
        v = struct.unpack_from("<f", self.b, self.p)[0]; self.p += 4; return v

    def f64(self):
        v = struct.unpack_from("<d", self.b, self.p)[0]; self.p += 8; return v

    def string(self):
        n = 0; sh = 0
        while True:
            x = self.u8()
            n |= (x & 0x7f) << sh
            if not (x & 0x80):
                break
            sh += 7
        s = self.b[self.p:self.p + n].decode("utf-8", "replace")
        self.p += n
        return s

    def prim(self, code):
        return {1: lambda: bool(self.u8()), 2: self.u8, 3: self.u8, 6: self.f64,
                7: self.i16, 8: self.i32, 9: self.i64, 11: self.f32,
                12: lambda: (self.i64(), "<TimeSpan>")[1], 13: lambda: (self.i64(), "<DateTime>")[1],
                18: self.string}[code]()

    def read_member_types(self, count):
        kinds = [self.u8() for _ in range(count)]
        infos = []
        for k in kinds:
            if k == 0:
                infos.append(("prim", self.u8()))
            elif k == 3:
                infos.append(("sysclass", self.string()))
            elif k == 4:
                infos.append(("class", (self.string(), self.i32())))
            elif k == 7:
                infos.append(("primarray", self.u8()))
            else:
                infos.append((k, None))
        return kinds, infos

    def read_value(self, kind, info):
        if kind == 0:
            return self.prim(info[1])
        return self.record()

    def read_members(self, names, kinds, infos, oid):
        obj = {"__id": oid}
        self.objects[oid] = obj
        for nm, k, inf in zip(names, kinds, infos):
            obj[nm] = self.read_value(k, inf)
        return obj

    def parse_all(self):
        self.record()
        while self.p < len(self.b) and self.b[self.p] != 11:
            self.record()

    def record(self):
        rt = self.u8()
        if rt == 0:
            self.p += 16; return self.record()
        if rt == 12:
            self.i32(); self.string(); return self.record()
        if rt == 11:
            self.p -= 1; return None
        if rt == 6:
            oid = self.i32(); v = self.string(); self.objects[oid] = v; return v
        if rt == 10:
            return None
        if rt == 13:
            return [None] * self.u8()
        if rt == 14:
            return [None] * self.i32()
        if rt == 9:
            return {"__ref": self.i32()}
        if rt == 8:
            return self.prim(self.u8())
        if rt in (4, 5):
            oid = self.i32(); name = self.string(); mc = self.i32()
            mnames = [self.string() for _ in range(mc)]
            kinds, infos = self.read_member_types(mc)
            if rt == 5:
                self.i32()
            self.classes[oid] = (name, mnames, kinds, infos)
            obj = self.read_members(mnames, kinds, infos, oid)
            obj["__class"] = name
            return obj
        if rt == 1:
            oid = self.i32(); meta = self.i32()
            name, mnames, kinds, infos = self.classes[meta]
            obj = self.read_members(mnames, kinds, infos, oid)
            obj["__class"] = name
            return obj
        if rt == 16:
            oid = self.i32(); length = self.i32()
            arr = []; self.objects[oid] = arr
            i = 0
            while i < length:
                v = self.record()
                if isinstance(v, list) and v and v[0] is None:
                    arr.extend(v); i += len(v)
                else:
                    arr.append(v); i += 1
            return arr
        if rt == 17:
            oid = self.i32(); length = self.i32()
            arr = []; self.objects[oid] = arr
            i = 0
            while i < length:
                v = self.record()
                if isinstance(v, list):
                    arr.extend(v); i += len(v)
                else:
                    arr.append(v); i += 1
            return arr
        if rt == 15:
            oid = self.i32(); length = self.i32(); code = self.u8()
            arr = [self.prim(code) for _ in range(length)]
            self.objects[oid] = arr
            return arr
        if rt == 7:
            oid = self.i32(); batype = self.u8(); rank = self.i32()
            lengths = [self.i32() for _ in range(rank)]
            if batype in (3, 4, 5):
                self.p += 4 * rank
            k, inf = self.read_member_types(1)
            total = 1
            for L in lengths:
                total *= L
            arr = []; self.objects[oid] = arr
            i = 0
            while i < total:
                v = self.read_value(k[0], inf[0])
                if isinstance(v, list) and v and v[0] is None:
                    arr.extend(v); i += len(v)
                else:
                    arr.append(v); i += 1
            return arr
        raise ValueError(f"record type {rt} @ {self.p}")

    def resolve(self, v, seen=None):
        seen = seen or set()
        if isinstance(v, dict):
            if "__ref" in v:
                r = v["__ref"]
                if r in seen:
                    return {"__cycle": r}
                return self.resolve(self.objects.get(r), seen | {r})
            return {k: self.resolve(x, seen) for k, x in v.items()}
        if isinstance(v, list):
            return [self.resolve(x, seen) for x in v]
        return v


def parse_signal_xml(xml):
    if not isinstance(xml, str):
        return {"label": None, "type": None}
    lbl = re.search(r"<Label>([^<]*)</Label>", xml)
    typ = re.search(r"<Type>([^<]*)</Type>", xml)
    return {"label": lbl.group(1) if lbl else None,
            "type": typ.group(1) if typ else None,
            "derived": "DerivedSignal" in xml}


def view_to_dict(v):
    sx = parse_signal_xml(v.get("_signalType"))
    return {
        "label": v.get("_label") or sx["label"],
        "signal_type": sx["type"],
        "derived": sx["derived"],
        "y_order": v.get("_yPosition"),
        "color": v.get("_signalColor") if isinstance(v.get("_signalColor"), str) else None,
        "axis_low": rnd(v.get("_axisLow")),
        "axis_high": rnd(v.get("_axisHigh")),
        "axis_locked": v.get("_lockAxis"),
        "highpass_hz": v.get("_lff"),          # low frequency filter = passe-haut
        "lowpass_hz": v.get("_hff"),           # high frequency filter = passe-bas
        "inverted": v.get("_inverted"),
        "fill": v.get("_fillSignal"),
        "notch_50hz": v.get("_powerLineFilter"),
        "ecg_adaptive_filter": v.get("_ecgAdaptiveFilter"),
        "frontal_display_filter": v.get("_frontalSignalDisplayFilter"),
    }


def rnd(x):
    return round(x, 4) if isinstance(x, float) else x


def collect(node, cls_suffix, out):
    if isinstance(node, dict):
        if str(node.get("__class", "")).endswith(cls_suffix):
            out.append(node)
        for x in node.values():
            collect(x, cls_suffix, out)
    elif isinstance(node, list):
        for x in node:
            collect(x, cls_suffix, out)


def main():
    con = sqlite3.connect(f"file:{NDB}?mode=ro", uri=True)
    blob = con.execute("SELECT data FROM workspace_workspace WHERE id=1").fetchone()[0]
    r = Reader(blob)
    r.parse_all()
    tree = r.resolve({"__ref": 1})

    sheets_raw = []
    collect(tree, "Model.SignalSheet", sheets_raw)

    def list_items(lst):
        if not isinstance(lst, dict):
            return []
        items = lst.get("_items") or []
        size = lst.get("_size")
        return items[:size] if isinstance(size, int) else items

    sheets = []
    for s in sheets_raw:
        name = s.get("_sheetName") or s.get("SheetModel+_name") or s.get("_name")
        window = s.get("_window") or s.get("SignalSheetModelBase+_window")
        span = s.get("_timeMarkerSpan") or s.get("SignalSheetModelBase+_timeMarkerSpan")
        views = list_items(s.get("_views") or s.get("SignalSheetModelBase+_views"))
        chans = [view_to_dict(v) for v in views
                 if isinstance(v, dict) and "_signalType" in v]
        chans.sort(key=lambda c: c["y_order"] if isinstance(c["y_order"], (int, float)) else 1e9)
        sheets.append({"name": name, "window": window, "half_step": span, "channels": chans})

    out = {"study": STUDY, "sheets": sheets}
    with open(os.path.join(BASE, "montage.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)

    for sh in sheets:
        print(f"\n=== {sh['name']}   (fenêtre {sh['window']}, demi-pas {sh['half_step']}) ===")
        print(f"  {'label':22s} {'signal NOX':32s} {'HP':>5s} {'LP':>6s} "
              f"{'axe bas':>10s} {'axe haut':>10s} verrou  couleur")
        for c in sh["channels"]:
            print(f"  {str(c['label'])[:22]:22s} {str(c['signal_type'])[:32]:32s} "
                  f"{fmt(c['highpass_hz']):>5s} {fmt(c['lowpass_hz']):>6s} "
                  f"{fmt(c['axis_low']):>10s} {fmt(c['axis_high']):>10s} "
                  f"{'oui' if c['axis_locked'] else 'non':>6s}  {c['color'] or ''}")
    print("\nmontage.json écrit.")


def fmt(x):
    if x is None:
        return "-"
    if isinstance(x, float):
        return f"{x:.3g}"
    return str(x)


if __name__ == "__main__":
    main()
