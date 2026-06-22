import config from "./eruvConfig.json";

export type LatLngTuple = [number, number];

export type BoundaryKind =
  | "notIncluded"
  | "innerSidewalk"
  | "innerSidewalkStreet"
  | "fullStreet";

export type MarkerType = "start" | "stop" | "reference";

export type BoundaryStyle = {
  color: string;
  dashArray?: string;
  label: string;
  weight: number;
};

export type BoundarySegment = {
  id: string;
  label: string;
  kind: BoundaryKind;
  points: LatLngTuple[];
  note: string;
};

export type BoundaryMarker = {
  id: string;
  label: string;
  position: LatLngTuple;
  type: MarkerType;
  description: string;
};

export type MapLabel = {
  fontSizePt?: number;
  fontWeight?: number;
  id: string;
  label: string;
  position: LatLngTuple;
  variant: "callout" | "handwritten" | "plain";
};

export type MapShape = {
  id: string;
  label: string;
  points: LatLngTuple[];
  strokeColor: string;
  fillColor: string;
  fillOpacity: number;
  weight: number;
};

export type EruvConfig = {
  title: string;
  englishTitle: string;
  kicker: string;
  subtitle: string;
  hotline: string;
  areaLabel: string;
  municipality: string;
  vaadTitle: string;
  vaadMembers: string[];
  configNote?: string;
  map: {
    center: LatLngTuple;
    screenFitPaddingRatio: number;
    printFitPaddingRatio: number;
    printPreview: {
      defaultZoomPercent: number;
      minZoomPercent: number;
      maxZoomPercent: number;
      stepPercent: number;
    };
  };
  boundaryStyles: Record<BoundaryKind, BoundaryStyle>;
  markerColors: Record<MarkerType, string>;
  markerLegendLabel: string;
  notes: string[];
  mapLabels: MapLabel[];
  mapShapes: MapShape[];
  boundarySegments: BoundarySegment[];
  boundaryMarkers: BoundaryMarker[];
};

export const eruvConfig = config as EruvConfig;

export const MAP_CENTER = eruvConfig.map.center;
export const boundaryStyles = eruvConfig.boundaryStyles;
export const boundarySegments = eruvConfig.boundarySegments;
export const boundaryMarkers = eruvConfig.boundaryMarkers;
export const markerColors = eruvConfig.markerColors;
export const mapLabels = eruvConfig.mapLabels;
export const mapShapes = eruvConfig.mapShapes;

export const boundaryFitPoints = [
  ...boundarySegments.flatMap((segment) => segment.points),
  ...boundaryMarkers.map((marker) => marker.position),
];

export const allBoundaryPoints = [
  ...boundaryFitPoints,
  ...mapLabels.map((label) => label.position),
  ...mapShapes.flatMap((shape) => shape.points),
];
