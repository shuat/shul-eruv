import { z } from "zod";
import type { EruvConfig } from "./mapData";

const point = z.tuple([z.number().min(-85).max(85), z.number().min(-180).max(180)]);
const text = z.string().max(10000);
const color = z.string().regex(/^#[0-9a-f]{6}$/i);
const id = z.string().min(1).max(200);
const weight = z.number().min(0).max(30);
const kind = z.enum(["notIncluded", "innerSidewalk", "innerSidewalkStreet", "fullStreet"]);
const style = z.object({
  color, weight: weight.positive(), label: text,
  dashArray: z.string().regex(/^[\d.,\s]+$/).optional(),
  innerColor: color.optional(), innerWeight: weight.optional(),
}).passthrough();
const schema = z.object({
  title: text, englishTitle: text, kicker: text, subtitle: text, hotline: text,
  areaLabel: text, municipality: text, vaadTitle: text, vaadMembers: z.array(text).max(100),
  notes: z.array(text).max(100), markerLegendLabel: text,
  map: z.object({
    center: point,
    screenFitPaddingRatio: z.number().min(0).max(1), printFitPaddingRatio: z.number().min(0).max(1),
    printPreview: z.object({
      defaultZoomPercent: z.number().min(25).max(300), minZoomPercent: z.number().min(25).max(300),
      maxZoomPercent: z.number().min(25).max(300), stepPercent: z.number().min(0.1).max(25),
    }).passthrough().refine(p => p.minZoomPercent <= p.defaultZoomPercent && p.defaultZoomPercent <= p.maxZoomPercent),
  }).passthrough(),
  boundaryStyles: z.object({ notIncluded: style, innerSidewalk: style, innerSidewalkStreet: style, fullStreet: style }).passthrough(),
  markerColors: z.object({ start: color, stop: color, reference: color }).passthrough(),
  boundarySegments: z.array(z.object({
    id, label: text, kind, points: z.array(point).min(2).max(10000), note: text,
    style: z.object({color: color.optional(), weight: weight.optional(), innerWeight: weight.optional()}).passthrough().optional(),
  }).passthrough()).min(1).max(1000),
  mapLabels: z.array(z.object({
    id, label: text, position: point, variant: z.enum(["plain", "callout", "handwritten"]),
    fontSizePt: z.number().min(4).max(36).optional(), fontWeight: z.number().min(100).max(950).optional(),
    widthPx: z.number().min(20).max(500).optional(), rotationDeg: z.number().min(-180).max(180).optional(), color: color.optional(),
  }).passthrough()).max(1000),
  boundaryMarkers: z.array(z.object({ id, label: text, position: point, type: z.enum(["start", "stop", "reference"]), description: text }).passthrough()).max(1000),
  mapShapes: z.array(z.object({ id, label: text, points: z.array(point).min(3).max(10000), strokeColor: color, fillColor: color, fillOpacity: z.number().min(0).max(1), weight }).passthrough()).max(1000),
}).passthrough();

export function parseConfig(json: string): EruvConfig {
  if (json.length > 2 * 1024 * 1024) throw new Error("JSON must be smaller than 2 MB.");
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw new Error("This file is not valid JSON."); }
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(`Invalid configuration at ${issue.path.join(".")}: ${issue.message}`);
  }
  for (const entries of [result.data.boundarySegments, result.data.mapLabels, result.data.boundaryMarkers, result.data.mapShapes]) {
    if (new Set(entries.map(e => e.id)).size !== entries.length) throw new Error("Each map item must have a unique ID within its collection.");
  }
  return result.data as EruvConfig;
}
