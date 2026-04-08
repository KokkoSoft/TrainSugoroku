from __future__ import annotations

import json
import math
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Dict, List, Set, Tuple

DATA_PATH = Path("StationData/UTF-8/N02-24_Station.geojson")
RAIL_PATH = Path("StationData/UTF-8/N02-24_RailroadSection.geojson")

CITY_OPERATORS: Dict[str, Set[str]] = {
    "札幌": {"札幌市"},
    "仙台": {"仙台市"},
    "東京": {"東京地下鉄", "東京都"},
    "横浜": {"横浜市"},
    "名古屋": {"名古屋市"},
    "京都": {"京都市"},
    "大阪": {"大阪市高速電気軌道", "大阪市"},
    "神戸": {"神戸市"},
    "福岡": {"福岡市"},
}


@dataclass(frozen=True)
class StationNode:
    station_id: str
    city: str
    name: str
    lat: float
    lon: float
    lines: Tuple[str, ...]


@dataclass(frozen=True)
class Edge:
    to_station_id: str
    line_key: str


class SubwayGraph:
    def __init__(self, city: str, nodes: Dict[str, StationNode], edges: Dict[str, List[Edge]]):
        self.city = city
        self.nodes = nodes
        self.edges = edges

    def station_choices(self) -> List[Tuple[str, str]]:
        return sorted((sid, node.name) for sid, node in self.nodes.items())

    def random_station_id(self, seed: int) -> str:
        keys = sorted(self.nodes.keys())
        return keys[seed % len(keys)]


def _dist(a: Tuple[float, float], b: Tuple[float, float]) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def _extract_latlon(geometry: dict) -> Tuple[float, float]:
    coords = geometry.get("coordinates", [])
    if not coords:
        return (0.0, 0.0)
    # 国交省の駅データはLineStringのため、単純平均で代表点を作る。
    if isinstance(coords[0], (int, float)) and len(coords) >= 2:
        return float(coords[1]), float(coords[0])
    total_lat = 0.0
    total_lon = 0.0
    n = 0
    for pair in coords:
        if isinstance(pair, list) and len(pair) >= 2:
            total_lon += float(pair[0])
            total_lat += float(pair[1])
            n += 1
    if n == 0:
        return (0.0, 0.0)
    return (total_lat / n, total_lon / n)


def _find_city(operator_name: str) -> str | None:
    for city, allowed in CITY_OPERATORS.items():
        if operator_name in allowed:
            return city
    return None


@lru_cache(maxsize=1)
def _load_station_features() -> List[dict]:
    with DATA_PATH.open("r", encoding="utf-8") as f:
        obj = json.load(f)
    return obj["features"]


@lru_cache(maxsize=1)
def _load_rail_features() -> List[dict]:
    with RAIL_PATH.open("r", encoding="utf-8") as f:
        obj = json.load(f)
    return obj["features"]


def _quant_lonlat(lon: float, lat: float) -> Tuple[float, float]:
    return (round(lon, 6), round(lat, 6))


def _extract_linestrings(geometry: dict) -> List[List[Tuple[float, float]]]:
    gtype = geometry.get("type", "")
    coords = geometry.get("coordinates", [])
    out: List[List[Tuple[float, float]]] = []
    if gtype == "LineString":
        out.append([(float(p[0]), float(p[1])) for p in coords if isinstance(p, list) and len(p) >= 2])
    elif gtype == "MultiLineString":
        for part in coords:
            out.append([(float(p[0]), float(p[1])) for p in part if isinstance(p, list) and len(p) >= 2])
    return [x for x in out if len(x) >= 2]


def _polyline_length(coords: List[Tuple[float, float]]) -> float:
    n = len(coords)
    if n <= 1:
        return 0.0
    total = 0.0
    for i in range(1, n):
        total += _dist((coords[i - 1][1], coords[i - 1][0]), (coords[i][1], coords[i][0]))
    return total


def _project_point_to_segment(
    px: float, py: float, ax: float, ay: float, bx: float, by: float
) -> Tuple[float, float, float]:
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    vv = vx * vx + vy * vy
    if vv <= 1e-15:
        return (0.0, ax, ay)
    t = (wx * vx + wy * vy) / vv
    if t < 0.0:
        t = 0.0
    elif t > 1.0:
        t = 1.0
    return (t, ax + t * vx, ay + t * vy)


def _project_point_to_polyline(lat: float, lon: float, coords: List[Tuple[float, float]]) -> Tuple[float, float]:
    best_d = float("inf")
    best_s = 0.0
    walked = 0.0
    for i in range(1, len(coords)):
        ax, ay = coords[i - 1][0], coords[i - 1][1]
        bx, by = coords[i][0], coords[i][1]
        t, qx, qy = _project_point_to_segment(lon, lat, ax, ay, bx, by)
        d = math.hypot(lon - qx, lat - qy)
        seg_len = math.hypot(bx - ax, by - ay)
        s = walked + t * seg_len
        if d < best_d:
            best_d = d
            best_s = s
        walked += seg_len
    return (best_s, best_d)


def _build_polylines_from_segments(segments: List[List[Tuple[float, float]]]) -> List[List[Tuple[float, float]]]:
    edge_by_node: Dict[Tuple[float, float], List[int]] = {}
    endpoints: List[Tuple[Tuple[float, float], Tuple[float, float]]] = []
    for idx, seg in enumerate(segments):
        a = _quant_lonlat(seg[0][0], seg[0][1])
        b = _quant_lonlat(seg[-1][0], seg[-1][1])
        endpoints.append((a, b))
        edge_by_node.setdefault(a, []).append(idx)
        edge_by_node.setdefault(b, []).append(idx)

    used: Set[int] = set()
    polylines: List[List[Tuple[float, float]]] = []

    def extend_from(start_node: Tuple[float, float]) -> None:
        node = start_node
        chain: List[Tuple[float, float]] = []
        while True:
            cand = [eid for eid in edge_by_node.get(node, []) if eid not in used]
            if not cand:
                break
            eid = cand[0]
            used.add(eid)
            seg = segments[eid]
            a, b = endpoints[eid]
            if node == a:
                piece = seg
                node = b
            else:
                piece = list(reversed(seg))
                node = a
            if not chain:
                chain = piece[:]
            else:
                chain.extend(piece[1:])
        if len(chain) >= 2:
            polylines.append(chain)

    degree1_nodes = sorted([n for n, es in edge_by_node.items() if len(es) == 1])
    for n in degree1_nodes:
        extend_from(n)
    for n in sorted(edge_by_node.keys()):
        extend_from(n)

    if not polylines:
        return segments
    return sorted(polylines, key=lambda c: (-_polyline_length(c), c[0][0], c[0][1]))


@lru_cache(maxsize=16)
def load_city_graph(city: str) -> SubwayGraph:
    if city not in CITY_OPERATORS:
        raise ValueError(f"unsupported city: {city}")

    raw = _load_station_features()

    station_meta: Dict[str, dict] = {}
    line_to_stations: Dict[str, Dict[str, Tuple[float, float]]] = {}
    station_lines: Dict[str, Set[str]] = {}

    for feat in raw:
        p = feat["properties"]
        operator = p["N02_004"]
        line = p["N02_003"]
        station_name = p["N02_005"]
        station_group = p["N02_005g"]
        c = _find_city(operator)
        if c != city:
            continue

        lat, lon = _extract_latlon(feat["geometry"])
        line_key = f"{operator}|{line}"

        if station_group not in station_meta:
            station_meta[station_group] = {
                "name": station_name,
                "lat": lat,
                "lon": lon,
            }

        line_to_stations.setdefault(line_key, {})[station_group] = (lat, lon)
        station_lines.setdefault(station_group, set()).add(line_key)

    nodes: Dict[str, StationNode] = {}
    for sid, meta in station_meta.items():
        nodes[sid] = StationNode(
            station_id=sid,
            city=city,
            name=meta["name"],
            lat=meta["lat"],
            lon=meta["lon"],
            lines=tuple(sorted(station_lines.get(sid, set()))),
        )

    edge_map: Dict[str, Set[Tuple[str, str]]] = {sid: set() for sid in nodes}

    # 路線順で隣接駅のみ接続する（近傍推定ショートカットを避ける）。
    for line_key, station_points in line_to_stations.items():
        if len(station_points) <= 1:
            continue

        ordered_ids = ordered_station_ids_by_line_geometry(city, line_key, station_points)
        ordered_ids = [sid for sid in ordered_ids if sid in station_points]
        if len(ordered_ids) >= 2:
            for i in range(1, len(ordered_ids)):
                a = ordered_ids[i - 1]
                b = ordered_ids[i]
                if a == b:
                    continue
                edge_map[a].add((b, line_key))
                edge_map[b].add((a, line_key))
            continue

        # 幾何順が作れない場合のみフォールバックで近傍接続。
        sids = list(station_points.keys())
        for sid in sids:
            latlon = station_points[sid]
            ranked: List[Tuple[float, str]] = []
            for other in sids:
                if other == sid:
                    continue
                ranked.append((_dist(latlon, station_points[other]), other))
            ranked.sort(key=lambda x: x[0])
            if ranked:
                other = ranked[0][1]
                edge_map[sid].add((other, line_key))
                edge_map[other].add((sid, line_key))

    edges: Dict[str, List[Edge]] = {
        sid: [Edge(to_station_id=t, line_key=l) for (t, l) in sorted(neis)] for sid, neis in edge_map.items()
    }

    return SubwayGraph(city=city, nodes=nodes, edges=edges)


def supported_cities() -> List[str]:
    return list(CITY_OPERATORS.keys())


def line_station_candidates(city: str, line_key: str) -> List[Dict[str, str]]:
    if city not in CITY_OPERATORS:
        raise ValueError(f"unsupported city: {city}")
    if "|" not in line_key:
        raise ValueError("invalid line_key")
    selected_operator, selected_line = line_key.split("|", 1)

    rows: Dict[str, Dict[str, float | str]] = {}
    for feat in _load_station_features():
        p = feat["properties"]
        op = p["N02_004"]
        line = p["N02_003"]
        group_id = p["N02_005g"]
        name = p["N02_005"]
        if line != selected_line:
            continue
        # 基本は対象都市。加えて同一路線名で同一事業者の駅は拾う。
        if _find_city(op) != city and op != selected_operator:
            continue
        lat, lon = _extract_latlon(feat["geometry"])
        rows[group_id] = {"name": name, "lat": lat, "lon": lon}

    out = [
        {"station_id": sid, "name": str(v["name"]), "lat": float(v["lat"]), "lon": float(v["lon"])}
        for sid, v in rows.items()
    ]
    out.sort(key=lambda x: (x["name"], x["station_id"]))
    return out


@lru_cache(maxsize=256)
def line_polylines(city: str, line_key: str) -> List[List[Tuple[float, float]]]:
    if "|" not in line_key:
        return []
    selected_operator, selected_line = line_key.split("|", 1)
    segs: List[List[Tuple[float, float]]] = []
    for feat in _load_rail_features():
        p = feat["properties"]
        op = p["N02_004"]
        line = p["N02_003"]
        if line != selected_line:
            continue
        if _find_city(op) != city and op != selected_operator:
            continue
        segs.extend(_extract_linestrings(feat["geometry"]))
    if not segs:
        return []
    return _build_polylines_from_segments(segs)


def ordered_station_ids_by_line_geometry(
    city: str,
    line_key: str,
    station_points: Dict[str, Tuple[float, float]],
) -> List[str]:
    polylines = line_polylines(city, line_key)
    if not polylines:
        return []

    assigned: Dict[str, Tuple[int, float, float]] = {}
    for sid, (lat, lon) in station_points.items():
        best = (10**9, 0.0, float("inf"))
        for idx, pl in enumerate(polylines):
            s, d = _project_point_to_polyline(lat, lon, pl)
            key = (idx, s, d)
            if key[2] < best[2]:
                best = key
        assigned[sid] = best

    rows = sorted(assigned.items(), key=lambda kv: (kv[1][0], kv[1][1], kv[1][2], kv[0]))
    return [sid for sid, _ in rows]
