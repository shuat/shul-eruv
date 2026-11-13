import { nearestPointOnLine } from "@turf/nearest-point-on-line";
import { lineSlice } from "@turf/line-slice";
import type { BoundarySegment, LatLngTuple } from "./mapData";

export type Road = { id: string; name: string; points: LatLngTuple[] };
const line = (road: Road) => ({
  type: "LineString" as const,
  coordinates: road.points.map(([lat, lng]) => [lng, lat]),
});
const coordinate = (p: number[]): LatLngTuple => [
  Number(p[1].toFixed(7)), Number(p[0].toFixed(7)),
];

export function nearestRoadPoint(point: LatLngTuple, roads: Road[], maxMeters = Infinity) {
  let best: { point: LatLngTuple; road: Road; distance: number } | null = null;
  for (const road of roads) {
    if (road.points.length < 2) continue;
    const result = nearestPointOnLine(line(road), [point[1], point[0]], { units: "meters" });
    const distance = result.properties.dist;
    if (distance <= maxMeters && (!best || distance < best.distance)) {
      best = { point: coordinate(result.geometry.coordinates), road, distance };
    }
  }
  return best;
}

export function followRoad(points: LatLngTuple[], road: Road, maxMeters = 80): LatLngTuple[] {
  if (points.length < 2) throw new Error("Select a line with at least two points.");
  const first = nearestRoadPoint(points[0], [road], maxMeters);
  const last = nearestRoadPoint(points[points.length - 1], [road], maxMeters);
  if (!first || !last) throw new Error("Both endpoints must be within 80 m of the selected road. Split the boundary or move its endpoints first.");
  const start = [first.point[1], first.point[0]];
  const end = [last.point[1], last.point[0]];
  const feature = line(road);
  let result = lineSlice(start, end, feature).geometry.coordinates;
  const a = nearestPointOnLine(feature, start).properties.location;
  const b = nearestPointOnLine(feature, end).properties.location;
  if (a > b) result = result.reverse();
  const converted = result.map(coordinate).filter((p, i, all) => i === 0 || !samePoint(p, all[i - 1]));
  if (converted.length < 2) throw new Error("The endpoints snap to the same place. Choose a longer section.");
  return converted;
}

export function samePoint(a: LatLngTuple, b: LatLngTuple) {
  return Math.abs(a[0] - b[0]) < 0.0000001 && Math.abs(a[1] - b[1]) < 0.0000001;
}

export function moveJoinedPoint(segments: BoundarySegment[], id: string, index: number, next: LatLngTuple) {
  const previous = segments.find(s => s.id === id)?.points[index];
  if (!previous) return segments;
  return segments.map(segment => ({
    ...segment,
    points: segment.points.map(p => samePoint(p, previous) ? [...next] as LatLngTuple : p),
  }));
}

export function replaceLine(segments: BoundarySegment[], id: string, points: LatLngTuple[]) {
  const selected = segments.find(s => s.id === id);
  if (!selected) return segments;
  let result = moveJoinedPoint(segments, id, 0, points[0]);
  result = moveJoinedPoint(result, id, selected.points.length - 1, points[points.length - 1]);
  return result.map(s => s.id === id ? { ...s, points } : s);
}

export function moveLine(segments: BoundarySegment[], id: string, points: LatLngTuple[]) {
  const selected = segments.find(segment => segment.id === id);
  if (!selected || selected.points.length !== points.length) return segments;
  return segments.map(segment => ({
    ...segment,
    points: segment.points.map(point => {
      const index = selected.points.findIndex(original => samePoint(point, original));
      return index < 0 ? point : [...points[index]] as LatLngTuple;
    }),
  }));
}
