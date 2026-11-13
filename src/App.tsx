import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import L from "leaflet";
import PathDrag from "leaflet-path-drag";
import "leaflet/dist/leaflet.css";
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  Upload,
  Pencil,
  Undo2,
  Redo2,
  Magnet,
  Square,
  Crosshair,
  Layers,
  MapPinned,
  Phone,
  Plus,
  Printer,
  RotateCcw,
  Route,
  Save,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import {
  boundarySegments,
  eruvConfig,
  mapLabels,
  mapShapes,
  type BoundaryKind,
  type BoundarySegment,
  type LatLngTuple,
  type MapLabel,
  type MapShape,
  type EruvConfig,
} from "./mapData";
import roadData from "./roads.json";
import { followRoad, moveJoinedPoint, moveLine, nearestRoadPoint, replaceLine, type Road } from "./editorGeometry";
import { parseConfig } from "./configImport";
import { lockMapInteractions } from "./mapDragLock";

const roads = roadData.roads as Road[];
type EditSnapshot = { config: EruvConfig; segments: BoundarySegment[]; labels: MapLabel[]; shapes: MapShape[]; zoom: number };

type BaseLayerKey = "standard" | "light";

const baseLayers: Record<
  BaseLayerKey,
  { label: string; url: string; attribution: string }
> = {
  standard: {
    label: "OSM",
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  },
  light: {
    label: "Light",
    url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
  },
};

const PRINT_PREP_CLASS = "print-prep";
const printPreviewDefaults = eruvConfig.map.printPreview;
const SAVE_CONFIG_ENDPOINT = "/api/save-config";
const mapLabelTypographyDefaults: Record<
  MapLabel["variant"],
  { fontSizePt: number; fontWeight: number }
> = {
  callout: { fontSizePt: 7.4, fontWeight: 850 },
  handwritten: { fontSizePt: 12, fontWeight: 900 },
  plain: { fontSizePt: 9.4, fontWeight: 800 },
};

function cloneMapLabels(): MapLabel[] {
  return mapLabels.map((label) => ({
    ...label,
    position: [...label.position] as LatLngTuple,
  }));
}

function cloneBoundarySegments(): BoundarySegment[] {
  return boundarySegments.map((segment) => ({
    ...segment,
    points: segment.points.map((point) => [...point] as LatLngTuple),
  }));
}

function roundCoordinate(value: number) {
  return Number(value.toFixed(7));
}

function roundFontSize(value: number) {
  return Number(value.toFixed(1));
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function isSaveModeEnabled() {
  if (!import.meta.env.DEV || typeof window === "undefined") {
    return false;
  }

  const params = new URLSearchParams(window.location.search);

  return params.get("edit") === "1" || params.get("save") === "1";
}

function getPointBetween(first: LatLngTuple, second: LatLngTuple): LatLngTuple {
  return [
    roundCoordinate((first[0] + second[0]) / 2),
    roundCoordinate((first[1] + second[1]) / 2),
  ];
}

function getMapLabelTypography(label: MapLabel) {
  const defaults = mapLabelTypographyDefaults[label.variant];

  return {
    fontSizePt: label.fontSizePt ?? defaults.fontSizePt,
    fontWeight: label.fontWeight ?? defaults.fontWeight,
  };
}

function getMapLabelBoxStyle(label: MapLabel) {
  const styleParts: string[] = [];
  if (label.color && /^#[0-9a-f]{6}$/i.test(label.color)) {
    styleParts.push(`color: ${label.color}`);
  }
  if (typeof label.rotationDeg === "number") {
    styleParts.push(`transform: rotate(${label.rotationDeg}deg)`, "transform-origin: top left");
  }

  if (typeof label.fontSizePt === "number") {
    styleParts.push(`font-size: ${roundFontSize(label.fontSizePt)}pt`);
  }

  if (typeof label.fontWeight === "number") {
    styleParts.push(`font-weight: ${Math.round(label.fontWeight)}`);
  }

  return styleParts.length > 0 ? ` style="${styleParts.join("; ")}"` : "";
}

async function writeClipboardText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    return;
  } catch {
    const textArea = document.createElement("textarea");
    textArea.value = value;
    textArea.setAttribute("readonly", "");
    textArea.style.position = "fixed";
    textArea.style.left = "-9999px";
    textArea.style.top = "0";
    document.body.appendChild(textArea);
    textArea.select();

    const copied = document.execCommand("copy");
    document.body.removeChild(textArea);

    if (!copied) {
      throw new Error("Unable to copy JSON");
    }
  }
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function App() {
  const [loadedConfig, setLoadedConfig] = useState(eruvConfig);
  const config = loadedConfig;
  const { boundaryStyles, boundaryMarkers } = config;
  const printPreviewDefaults = config.map.printPreview;
  const [isEditMode, setIsEditMode] = useState(false);
  const [isMapLocked, setIsMapLocked] = useState(true);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [selectedRoadId, setSelectedRoadId] = useState("");
  const [editorStatus, setEditorStatus] = useState("");
  const [editableMapShapes, setEditableMapShapes] = useState(() => structuredClone(mapShapes));
  const [selectedShapeId, setSelectedShapeId] = useState("");
  const importInputRef = useRef<HTMLInputElement>(null);
  const historyRef = useRef<EditSnapshot[]>([]);
  const historyIndex = useRef(-1);
  const restoringHistory = useRef(false);
  const [historyVersion, setHistoryVersion] = useState(0);
  const mapNodeRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const overlayRef = useRef<L.FeatureGroup | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  const [baseLayer, setBaseLayer] = useState<BaseLayerKey>("standard");
  const [showBoundary, setShowBoundary] = useState(true);
  const [showMarkers, setShowMarkers] = useState(true);
  const [isPrintPreview, setIsPrintPreview] = useState(false);
  const isEditing = isEditMode || isPrintPreview;
  const [editableBoundarySegments, setEditableBoundarySegments] = useState(
    cloneBoundarySegments,
  );
  const [selectedBoundarySegmentId, setSelectedBoundarySegmentId] = useState(
    () => boundarySegments[0]?.id ?? "",
  );
  const [selectedBoundaryPointIndex, setSelectedBoundaryPointIndex] =
    useState(0);
  const [editableMapLabels, setEditableMapLabels] = useState(cloneMapLabels);
  const [selectedMapLabelId, setSelectedMapLabelId] = useState(
    () => mapLabels[0]?.id ?? "",
  );
  const [printZoomPercent, setPrintZoomPercent] = useState(
    printPreviewDefaults.defaultZoomPercent,
  );
  const [jsonCopyStatus, setJsonCopyStatus] = useState("Copy JSON");
  const [jsonOutput, setJsonOutput] = useState("");
  const [jsonSaveStatus, setJsonSaveStatus] = useState("Save JSON");
  const [jsonSaveError, setJsonSaveError] = useState("");
  const [canSaveConfig] = useState(isSaveModeEnabled);

  const mapBounds = useMemo(
    () => L.latLngBounds((editableBoundarySegments.length ? editableBoundarySegments : boundarySegments).flatMap(s => s.points)),
    [editableBoundarySegments],
  );
  const boundsRef = useRef(mapBounds);
  boundsRef.current = mapBounds;
  const selectedRoad = roads.find(road => road.id === selectedRoadId);
  const selectedShape = editableMapShapes.find(shape => shape.id === selectedShapeId);

  useEffect(() => {
    if (restoringHistory.current) { restoringHistory.current = false; return; }
    const snapshot = { config, segments: editableBoundarySegments, labels: editableMapLabels, shapes: editableMapShapes, zoom: printZoomPercent };
    if (JSON.stringify(historyRef.current[historyIndex.current]) === JSON.stringify(snapshot)) return;
    historyRef.current = [...historyRef.current.slice(0, historyIndex.current + 1), structuredClone(snapshot)].slice(-60);
    historyIndex.current = historyRef.current.length - 1;
    setHistoryVersion(v => v + 1);
  }, [config, editableBoundarySegments, editableMapLabels, editableMapShapes, printZoomPercent]);
  const selectedMapLabel = useMemo(
    () =>
      editableMapLabels.find((label) => label.id === selectedMapLabelId) ??
      editableMapLabels[0] ??
      null,
    [editableMapLabels, selectedMapLabelId],
  );
  const selectedMapLabelTypography = selectedMapLabel
    ? getMapLabelTypography(selectedMapLabel)
    : null;
  const selectedBoundarySegment = useMemo(
    () =>
      editableBoundarySegments.find(
        (segment) => segment.id === selectedBoundarySegmentId,
      ) ??
      editableBoundarySegments[0] ??
      null,
    [editableBoundarySegments, selectedBoundarySegmentId],
  );
  const selectedBoundaryPointCount =
    selectedBoundarySegment?.points.length ?? 0;

  const markJsonDirty = useCallback(() => {
    setJsonCopyStatus("Copy JSON");
    setJsonOutput("");
    setJsonSaveStatus("Save JSON");
    setJsonSaveError("");
  }, []);

  const waitForFrames = useCallback((count: number) => {
    return new Promise<void>((resolve) => {
      const step = (remaining: number) => {
        if (remaining === 0) {
          resolve();
          return;
        }

        window.requestAnimationFrame(() => step(remaining - 1));
      };

      step(count);
    });
  }, []);

  useEffect(() => {
    if (
      editableMapLabels.length > 0 &&
      !editableMapLabels.some((label) => label.id === selectedMapLabelId)
    ) {
      setSelectedMapLabelId(editableMapLabels[0].id);
    }
  }, [editableMapLabels, selectedMapLabelId]);

  useEffect(() => {
    if (
      editableBoundarySegments.length > 0 &&
      !editableBoundarySegments.some(
        (segment) => segment.id === selectedBoundarySegmentId,
      )
    ) {
      setSelectedBoundarySegmentId(editableBoundarySegments[0].id);
    }
  }, [editableBoundarySegments, selectedBoundarySegmentId]);

  useEffect(() => {
    setSelectedBoundaryPointIndex(0);
  }, [selectedBoundarySegmentId]);

  useEffect(() => {
    if (selectedBoundaryPointCount === 0) {
      setSelectedBoundaryPointIndex(0);
      return;
    }

    if (selectedBoundaryPointIndex >= selectedBoundaryPointCount) {
      setSelectedBoundaryPointIndex(selectedBoundaryPointCount - 1);
    }
  }, [selectedBoundaryPointCount, selectedBoundaryPointIndex]);

  const waitForMapSettled = useCallback(() => {
    const map = mapRef.current;
    const tileLayer = tileLayerRef.current;

    if (!map) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }

        settled = true;
        map.off("moveend", finish);
        tileLayer?.off("load", finish);
        resolve();
      };

      map.once("moveend", finish);
      tileLayer?.once("load", finish);
      window.setTimeout(finish, 900);
    });
  }, []);

  useEffect(() => {
    if (!mapNodeRef.current || mapRef.current) {
      return;
    }

    const map = L.map(mapNodeRef.current, {
      center: mapBounds.getCenter(),
      zoom: 15,
      minZoom: 13,
      maxZoom: 19,
      zoomDelta: 0.25,
      zoomSnap: 0.1,
      zoomControl: false,
      preferCanvas: true,
    });
    map.createPane("editor-guides");
    map.getPane("editor-guides")!.style.zIndex = "350";

    L.control.zoom({ position: "bottomright" }).addTo(map);
    const fitInitialView = () => {
      if (document.body.classList.contains(PRINT_PREP_CLASS)) return;
      map.invalidateSize(false);
      map.fitBounds(mapBounds.pad(eruvConfig.map.screenFitPaddingRatio), {
        animate: false,
        padding: [44, 44],
      });
    };

    fitInitialView();
    const frameId = window.requestAnimationFrame(fitInitialView);
    const timeoutId = window.setTimeout(fitInitialView, 350);
    mapRef.current = map;

    return () => {
      window.cancelAnimationFrame(frameId);
      window.clearTimeout(timeoutId);
      map.remove();
      mapRef.current = null;
      tileLayerRef.current = null;
      overlayRef.current = null;
    };
  }, []);

  useEffect(() => {
    const frame = requestAnimationFrame(() => mapRef.current?.invalidateSize(false));
    return () => cancelAnimationFrame(frame);
  }, [isEditMode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isEditing || !isMapLocked) return;
    map.stop();
    return lockMapInteractions([
      map.dragging, map.touchZoom, map.scrollWheelZoom,
      map.doubleClickZoom, map.boxZoom, map.keyboard,
    ]);
  }, [isEditing, isMapLocked]);

  useEffect(() => {
    const map = mapRef.current;

    if (!map) {
      return;
    }

    if (tileLayerRef.current) {
      tileLayerRef.current.remove();
    }

    const selected = baseLayers[baseLayer];
    tileLayerRef.current = L.tileLayer(selected.url, {
      attribution: selected.attribution,
      maxZoom: 19,
      crossOrigin: true,
    }).addTo(map);
  }, [baseLayer]);

  useEffect(() => {
    const map = mapRef.current;

    if (!map) {
      return;
    }

    if (overlayRef.current) {
      overlayRef.current.eachLayer(layer => {
        layer.unbindTooltip();
        layer.unbindPopup();
      });
      overlayRef.current.remove();
    }

    const group = L.featureGroup();
    const dragRenderer = isEditing ? L.svg({ padding: 0.5 }).addTo(map) : undefined;
    const pathDragHandlers: PathDrag[] = [];
    let releaseMap = () => {};
    const lockMap = () => {
      releaseMap();
      releaseMap = lockMapInteractions([
        map.dragging, map.touchZoom, map.scrollWheelZoom,
        map.doubleClickZoom, map.boxZoom, map.keyboard,
      ]);
    };
    if (isEditing && selectedRoad) {
      L.polyline(selectedRoad.points, { pane: "editor-guides", color: "#1685bf", weight: 9, opacity: 0.25, interactive: false }).addTo(group);
    }

    if (showBoundary) {
      editableBoundarySegments.forEach((segment) => {
        const style = { ...boundaryStyles[segment.kind], ...segment.style };
        const vertexMarkers: L.Marker[] = [];
        let innerLine: L.Polyline | undefined;
        let lineHitTarget: L.Polyline | undefined;

        const boundaryLine = L.polyline(segment.points, {
          color: style.color,
          dashArray: style.dashArray,
          lineCap: "round",
          lineJoin: "round",
          opacity: 0.96,
          weight: style.weight,
        }).bindTooltip(`<strong>${escapeHtml(segment.label)}</strong><br />${escapeHtml(segment.note)}`, {
            sticky: true,
          });

        if (isEditing) {
          boundaryLine.on("click", () => {
            setSelectedBoundarySegmentId(segment.id);
          });
        }

        boundaryLine.addTo(group);
        if (style.innerColor && style.innerWeight) {
          innerLine = L.polyline(segment.points, {
            color: style.innerColor,
            weight: style.innerWeight,
            interactive: false,
            lineCap: "round",
            lineJoin: "round",
          }).addTo(group);
        }

        if (isEditing && segment.id === selectedBoundarySegmentId) {
          segment.points.forEach((point, pointIndex) => {
            const isSelectedPoint = pointIndex === selectedBoundaryPointIndex;
            const vertexMarker = L.marker(point, {
              title: `Boundary point ${pointIndex + 1}`,
              draggable: true,
              icon: L.divIcon({
                className: `boundary-edit-handle${
                  isSelectedPoint ? " boundary-edit-handle-selected" : ""
                }`,
                html: `<span>${pointIndex + 1}</span>`,
                iconAnchor: [9, 9],
                iconSize: [18, 18],
              }),
              interactive: true,
              zIndexOffset: 1200,
            });

            vertexMarker.on("click", () => {
              setSelectedBoundarySegmentId(segment.id);
              setSelectedBoundaryPointIndex(pointIndex);
            });

            vertexMarker.on("dragstart", () => {
              lockMap();
              vertexMarker.closeTooltip();
            });

            vertexMarker.on("drag", () => {
              if (snapEnabled) {
                const position = vertexMarker.getLatLng();
                const pixel = map.latLngToContainerPoint(position);
                const tolerance = map.distance(position, map.containerPointToLatLng(pixel.add([16, 0])));
                const match = nearestRoadPoint([position.lat, position.lng], selectedRoad ? [selectedRoad] : roads, tolerance);
                if (match) vertexMarker.setLatLng(match.point);
              }
              const position = vertexMarker.getLatLng();
              const points = segment.points.map((point, index) => index === pointIndex ? position : L.latLng(point));
              boundaryLine.setLatLngs(points);
              innerLine?.setLatLngs(points);
              lineHitTarget?.setLatLngs(points);
            });

            vertexMarker.on("dragend", () => {
              releaseMap();
              const nextPosition = vertexMarker.getLatLng();

              setSelectedBoundarySegmentId(segment.id);
              setSelectedBoundaryPointIndex(pointIndex);
              setEditableBoundarySegments(current => moveJoinedPoint(current, segment.id, pointIndex,
                [roundCoordinate(nextPosition.lat), roundCoordinate(nextPosition.lng)]));
              markJsonDirty();
            });

            vertexMarker.addTo(group);
            vertexMarkers.push(vertexMarker);
          });
        }

        if (isEditing) {
          // A continuous wide hit area makes thin and dotted boundaries easy to grab.
          const hitLine = L.polyline(segment.points, {
            renderer: dragRenderer, weight: Math.max(20, style.weight), opacity: 0,
            className: "boundary-drag-target", bubblingMouseEvents: false,
          }).addTo(group);
          lineHitTarget = hitLine;
          const draggable = PathDrag.makeDraggable(hitLine);
          draggable.dragging.enable();
          pathDragHandlers.push(draggable.dragging);
          hitLine.on("add", () => hitLine.getElement()?.setAttribute("aria-label", `Move line: ${segment.label}`));
          hitLine.on("click", () => setSelectedBoundarySegmentId(segment.id));
          hitLine.on("dragstart", lockMap);
          hitLine.on("drag", () => {
            const points = hitLine.getLatLngs().flat(2) as L.LatLng[];
            boundaryLine.setLatLngs(points);
            innerLine?.setLatLngs(points);
            vertexMarkers.forEach((marker, index) => marker.setLatLng(points[index]));
          });
          hitLine.on("dragend", () => {
            releaseMap();
            const points = (hitLine.getLatLngs().flat(2) as L.LatLng[]).map(point =>
              [roundCoordinate(point.lat), roundCoordinate(point.lng)] as LatLngTuple);
            setEditableBoundarySegments(current => moveLine(current, segment.id, points));
            setSelectedBoundarySegmentId(segment.id);
            markJsonDirty();
          });
        }
      });

      editableMapShapes.forEach((shape) => {
        const polygon = L.polygon(shape.points, {
          color: shape.strokeColor,
          fillColor: shape.fillColor,
          fillOpacity: shape.fillOpacity,
          lineJoin: "round",
          opacity: 0.95,
          weight: shape.weight,
        })
          .bindTooltip(`<strong>${escapeHtml(shape.label)}</strong>`, {
            sticky: true,
          })
          .addTo(group);
        if (isEditing) polygon.on("click", () => setSelectedShapeId(shape.id));
        if (isEditing && shape.id === selectedShapeId) {
          shape.points.forEach((point, index) => {
            const handle = L.marker(point, {
              draggable: true,
              icon: L.divIcon({ className: "shape-edit-handle", html: "<span></span>", iconSize: [12, 12], iconAnchor: [6, 6] }),
              zIndexOffset: 1100,
            }).addTo(group);
            handle.on("dragstart", lockMap);
            handle.on("dragend", () => {
              releaseMap();
              const p = handle.getLatLng();
              setEditableMapShapes(current => current.map(s => s.id === shape.id ? {
                ...s, points: s.points.map((v, i) => i === index ? [roundCoordinate(p.lat), roundCoordinate(p.lng)] : v),
              } : s));
              markJsonDirty();
            });
          });
        }
      });
    }

    if (showMarkers) {
      boundaryMarkers.forEach((marker) => {
        const markerLayer = L.circleMarker(marker.position, {
          radius: 2,
          color: "#17212f",
          fillColor: "#222222",
          fillOpacity: 1,
          opacity: 1,
          weight: 0,
        });

        markerLayer
          .bindTooltip(escapeHtml(marker.label), {
            className: "marker-label",
            direction: "top",
            offset: [0, -2],
            permanent: true,
          })
          .bindPopup(`<strong>${escapeHtml(marker.label)}</strong><br />${escapeHtml(marker.description)}`)
          .addTo(group);
      });

      editableMapLabels.forEach((label) => {
        const isSelectedLabel = isEditing && label.id === selectedMapLabelId;
        const iconWidth = label.widthPx ?? (
          label.variant === "callout"
            ? 176
            : label.variant === "handwritten"
              ? 84
              : 92);
        const iconHeight = label.variant === "callout" ? 64 : 24;

        const labelMarker = L.marker(label.position, {
          title: label.label,
          draggable: isEditing,
          icon: L.divIcon({
            className: `map-text-label map-text-label-${label.variant}${
              isEditing ? " map-label-editing" : ""
            }${isSelectedLabel ? " map-label-selected" : ""}`,
            html: `<span class="map-label-box"${getMapLabelBoxStyle(label)}>${escapeHtml(
              label.label,
            )}</span>`,
            iconAnchor: [label.rotationDeg ? 0 : iconWidth / 2, 0],
            iconSize: [iconWidth, iconHeight],
          }),
          interactive: isEditing,
        });

        if (isEditing) {
          labelMarker.on("dragstart", lockMap);
          labelMarker.on("click", () => {
            setSelectedMapLabelId(label.id);
          });

          labelMarker.on("dragend", () => {
            releaseMap();
            const nextPosition = labelMarker.getLatLng();

            setSelectedMapLabelId(label.id);
            setEditableMapLabels((currentLabels) =>
              currentLabels.map((currentLabel) =>
                currentLabel.id === label.id
                  ? {
                      ...currentLabel,
                      position: [
                        roundCoordinate(nextPosition.lat),
                        roundCoordinate(nextPosition.lng),
                      ],
                    }
                  : currentLabel,
              ),
            );
            markJsonDirty();
          });
        }

        labelMarker.addTo(group);
      });
    }

    group.addTo(map);
    overlayRef.current = group;
    return () => {
      releaseMap();
      pathDragHandlers.forEach(handler => handler.disable());
      group.eachLayer(layer => {
        layer.unbindTooltip();
        layer.unbindPopup();
      });
      group.remove();
      dragRenderer?.remove();
      if (overlayRef.current === group) overlayRef.current = null;
    };
  }, [
    editableBoundarySegments,
    editableMapLabels,
    isEditing,
    snapEnabled,
    selectedRoad,
    editableMapShapes,
    selectedShapeId,
    boundaryStyles,
    boundaryMarkers,
    markJsonDirty,
    selectedBoundarySegmentId,
    selectedBoundaryPointIndex,
    selectedMapLabelId,
    showBoundary,
    showMarkers,
  ]);

  const fitToBoundary = useCallback(
    (forPrint = false, zoomPercent = printZoomPercent) => {
      const map = mapRef.current;

      if (!map) {
        return;
      }

      map.invalidateSize(false);

      if (forPrint) {
        const printPadding = L.point(4, 4);
        const bounds = boundsRef.current.pad(config.map.printFitPaddingRatio);
        const fitZoom = map.getBoundsZoom(bounds, false, printPadding);
        const zoomOffset = (zoomPercent - 100) / 25;
        const nextZoom = Math.min(
          map.getMaxZoom(),
          Math.max(map.getMinZoom(), fitZoom + zoomOffset),
        );

        map.setView(bounds.getCenter(), nextZoom, { animate: false });
        return;
      }

      map.fitBounds(boundsRef.current.pad(config.map.screenFitPaddingRatio), {
        animate: false,
        padding: [44, 44],
      });
    },
    [config.map, printZoomPercent],
  );

  const enterPrintPrep = useCallback(async (zoomPercent = printZoomPercent) => {
    document.body.classList.add(PRINT_PREP_CLASS);
    await waitForFrames(2);
    fitToBoundary(true, zoomPercent);
    await waitForFrames(2);
    fitToBoundary(true, zoomPercent);
    await waitForMapSettled();
  }, [fitToBoundary, printZoomPercent, waitForFrames, waitForMapSettled]);

  const exitPrintPrep = useCallback(() => {
    document.body.classList.remove(PRINT_PREP_CLASS);
    window.requestAnimationFrame(() => fitToBoundary(false));
  }, [fitToBoundary]);

  useEffect(() => {
    const preparePrint = () => {
      document.body.classList.add(PRINT_PREP_CLASS);
      fitToBoundary(true, printZoomPercent);
    };

    const finishPrint = () => {
      setIsPrintPreview(false);
      exitPrintPrep();
    };

    window.addEventListener("beforeprint", preparePrint);
    window.addEventListener("afterprint", finishPrint);

    return () => {
      window.removeEventListener("beforeprint", preparePrint);
      window.removeEventListener("afterprint", finishPrint);
    };
  }, [exitPrintPrep, fitToBoundary, printZoomPercent]);

  useEffect(() => {
    if (!isPrintPreview) {
      return;
    }

    let canceled = false;

    const refreshPrintPreview = async () => {
      document.body.classList.add(PRINT_PREP_CLASS);
      await waitForFrames(2);

      if (canceled) {
        return;
      }

      fitToBoundary(true, printZoomPercent);
      await waitForFrames(1);

      if (!canceled) {
        fitToBoundary(true, printZoomPercent);
      }
    };

    refreshPrintPreview();

    return () => {
      canceled = true;
    };
  }, [fitToBoundary, isPrintPreview, printZoomPercent, waitForFrames]);

  const openPrintPreview = useCallback(() => {
    setShowBoundary(true);
    setShowMarkers(true);
    setIsPrintPreview(true);
  }, []);

  const closePrintPreview = useCallback(() => {
    setIsPrintPreview(false);
    exitPrintPrep();
  }, [exitPrintPrep]);

  useEffect(() => {
    if (jsonCopyStatus !== "Copied") {
      return;
    }

    const timeoutId = window.setTimeout(
      () => setJsonCopyStatus("Copy JSON"),
      1800,
    );

    return () => window.clearTimeout(timeoutId);
  }, [jsonCopyStatus]);

  useEffect(() => {
    if (jsonSaveStatus !== "Saved") {
      return;
    }

    const timeoutId = window.setTimeout(
      () => setJsonSaveStatus("Save JSON"),
      1800,
    );

    return () => window.clearTimeout(timeoutId);
  }, [jsonSaveStatus]);

  const updatePrintZoom = useCallback((value: string) => {
    const nextValue = Number(value);

    if (Number.isNaN(nextValue)) {
      return;
    }

    setPrintZoomPercent(
      Math.min(
        printPreviewDefaults.maxZoomPercent,
        Math.max(printPreviewDefaults.minZoomPercent, nextValue),
      ),
    );
    markJsonDirty();
  }, [markJsonDirty]);

  const updateSelectedMapLabelFontSize = useCallback(
    (value: string) => {
      if (!selectedMapLabel) {
        return;
      }

      const nextValue = Number(value);

      if (Number.isNaN(nextValue)) {
        return;
      }

      const fontSizePt = roundFontSize(clampNumber(nextValue, 4, 18));

      setEditableMapLabels((currentLabels) =>
        currentLabels.map((label) =>
          label.id === selectedMapLabel.id ? { ...label, fontSizePt } : label,
        ),
      );
      markJsonDirty();
    },
    [markJsonDirty, selectedMapLabel],
  );

  const updateSelectedMapLabelFontWeight = useCallback(
    (value: string) => {
      if (!selectedMapLabel) {
        return;
      }

      const nextValue = Number(value);

      if (Number.isNaN(nextValue)) {
        return;
      }

      const fontWeight = Math.round(clampNumber(nextValue, 300, 950));

      setEditableMapLabels((currentLabels) =>
        currentLabels.map((label) =>
          label.id === selectedMapLabel.id ? { ...label, fontWeight } : label,
        ),
      );
      markJsonDirty();
    },
    [markJsonDirty, selectedMapLabel],
  );

  const updateSelectedBoundaryKind = useCallback(
    (value: BoundaryKind) => {
      if (!selectedBoundarySegment) {
        return;
      }

      setEditableBoundarySegments((currentSegments) =>
        currentSegments.map((segment) =>
          segment.id === selectedBoundarySegment.id
            ? { ...segment, kind: value, style: value === segment.kind ? segment.style : undefined }
            : segment,
        ),
      );
      markJsonDirty();
    },
    [markJsonDirty, selectedBoundarySegment],
  );

  const addBoundaryPoint = useCallback(() => {
    if (!selectedBoundarySegment || selectedBoundaryPointCount === 0) {
      return;
    }

    const pointIndex = Math.round(
      clampNumber(selectedBoundaryPointIndex, 0, selectedBoundaryPointCount - 1),
    );
    const points = selectedBoundarySegment.points;
    let insertIndex = pointIndex + 1;
    let nextPoint: LatLngTuple;

    if (pointIndex < points.length - 1) {
      nextPoint = getPointBetween(points[pointIndex], points[pointIndex + 1]);
    } else if (pointIndex > 0) {
      insertIndex = pointIndex;
      nextPoint = getPointBetween(points[pointIndex - 1], points[pointIndex]);
    } else {
      nextPoint = [...points[pointIndex]] as LatLngTuple;
    }

    setEditableBoundarySegments((currentSegments) =>
      currentSegments.map((segment) =>
        segment.id === selectedBoundarySegment.id
          ? {
              ...segment,
              points: [
                ...segment.points.slice(0, insertIndex),
                nextPoint,
                ...segment.points.slice(insertIndex),
              ],
            }
          : segment,
      ),
    );
    setSelectedBoundaryPointIndex(insertIndex);
    markJsonDirty();
  }, [
    markJsonDirty,
    selectedBoundaryPointCount,
    selectedBoundaryPointIndex,
    selectedBoundarySegment,
  ]);

  const removeBoundaryPoint = useCallback(() => {
    if (!selectedBoundarySegment || selectedBoundaryPointCount <= 2) {
      return;
    }

    const pointIndex = Math.round(
      clampNumber(selectedBoundaryPointIndex, 0, selectedBoundaryPointCount - 1),
    );
    const nextSelectedIndex = Math.min(pointIndex, selectedBoundaryPointCount - 2);

    setEditableBoundarySegments((currentSegments) =>
      currentSegments.map((segment) =>
        segment.id === selectedBoundarySegment.id
          ? {
              ...segment,
              points: segment.points.filter((_, index) => index !== pointIndex),
            }
          : segment,
      ),
    );
    setSelectedBoundaryPointIndex(nextSelectedIndex);
    markJsonDirty();
  }, [
    markJsonDirty,
    selectedBoundaryPointCount,
    selectedBoundaryPointIndex,
    selectedBoundarySegment,
  ]);

  const resetSelectedMapLabelTypography = useCallback(() => {
    if (!selectedMapLabel) {
      return;
    }

    setEditableMapLabels((currentLabels) =>
      currentLabels.map((label) => {
        if (label.id !== selectedMapLabel.id) {
          return label;
        }

        const nextLabel = { ...label };

        delete nextLabel.fontSizePt;
        delete nextLabel.fontWeight;

        return nextLabel;
      }),
    );
    markJsonDirty();
  }, [markJsonDirty, selectedMapLabel]);

  const resetBoundarySegments = useCallback(() => {
    setEditableBoundarySegments(structuredClone(config.boundarySegments));
    setSelectedBoundaryPointIndex(0);
    markJsonDirty();
  }, [markJsonDirty, config]);

  const resetMapLabels = useCallback(() => {
    setEditableMapLabels(structuredClone(config.mapLabels));
    markJsonDirty();
  }, [markJsonDirty, config]);

  const buildUpdatedConfig = useCallback(
    () => ({
      ...config,
      mapShapes: editableMapShapes,
      map: {
        ...config.map,
        printPreview: {
          ...config.map.printPreview,
          defaultZoomPercent: printZoomPercent,
        },
      },
      boundarySegments: editableBoundarySegments.map((segment) => ({
        ...segment,
        points: segment.points.map((point) => [
          roundCoordinate(point[0]),
          roundCoordinate(point[1]),
        ]),
      })),
      mapLabels: editableMapLabels.map((label) => ({
        ...label,
        ...(typeof label.fontSizePt === "number"
          ? { fontSizePt: roundFontSize(label.fontSizePt) }
          : {}),
        ...(typeof label.fontWeight === "number"
          ? { fontWeight: Math.round(label.fontWeight) }
          : {}),
        position: [
          roundCoordinate(label.position[0]),
          roundCoordinate(label.position[1]),
        ],
      })),
    }),
    [config, editableMapShapes, editableBoundarySegments, editableMapLabels, printZoomPercent],
  );

  const copyUpdatedJson = useCallback(async () => {
    const updatedJson = JSON.stringify(buildUpdatedConfig(), null, 2);

    try {
      await writeClipboardText(updatedJson);
      setJsonOutput("");
      setJsonCopyStatus("Copied");
    } catch {
      setJsonOutput(updatedJson);
      setJsonCopyStatus("JSON ready");
    }
  }, [buildUpdatedConfig]);

  const saveUpdatedJson = useCallback(async () => {
    if (!canSaveConfig) {
      return;
    }

    setJsonSaveStatus("Saving...");
    setJsonSaveError("");

    try {
      const response = await fetch(SAVE_CONFIG_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: buildUpdatedConfig() }),
      });

      if (!response.ok) {
        const message = await response.text();
        throw new Error(message || `Save failed (${response.status})`);
      }

      setJsonSaveStatus("Saved");
    } catch (error) {
      setJsonSaveStatus("Save failed");
      setJsonSaveError(
        error instanceof Error ? error.message : "Unable to save JSON",
      );
    }
  }, [buildUpdatedConfig, canSaveConfig]);

  function stepHistory(direction: -1 | 1) {
    const next = historyIndex.current + direction;
    const snapshot = historyRef.current[next];
    if (!snapshot) return;
    restoringHistory.current = true;
    historyIndex.current = next;
    setLoadedConfig(snapshot.config);
    setEditableBoundarySegments(snapshot.segments);
    setEditableMapLabels(snapshot.labels);
    setEditableMapShapes(snapshot.shapes);
    setPrintZoomPercent(snapshot.zoom);
    setHistoryVersion(v => v + 1);
    markJsonDirty();
    setEditorStatus(direction < 0 ? "Undone" : "Redone");
  }

  function patchLabel(patch: Partial<MapLabel>) {
    if (!selectedMapLabel) return;
    setEditableMapLabels(current => current.map(label => label.id === selectedMapLabel.id ? { ...label, ...patch } : label));
    markJsonDirty();
  }

  function addTextBox() {
    const center = mapRef.current?.getCenter();
    if (!center) return;
    const label: MapLabel = { id: `note-${crypto.randomUUID()}`, label: "New note", variant: "callout",
      position: [roundCoordinate(center.lat), roundCoordinate(center.lng)], widthPx: 150, fontSizePt: 7.4, fontWeight: 600 };
    setEditableMapLabels(current => [...current, label]);
    setSelectedMapLabelId(label.id);
    setShowMarkers(true);
    markJsonDirty();
  }

  function addAreaBox() {
    const map = mapRef.current;
    if (!map) return;
    const center = map.latLngToContainerPoint(map.getCenter());
    const points = [[-35,-40],[35,-40],[35,40],[-35,40]].map(([x,y]): LatLngTuple => {
      const point = map.containerPointToLatLng(center.add([x,y]));
      return [roundCoordinate(point.lat), roundCoordinate(point.lng)];
    });
    const shape: MapShape = { id: `area-${crypto.randomUUID()}`, label: "New area", points,
      strokeColor: "#aa4841", fillColor: "#ffffff", fillOpacity: 0, weight: 2 };
    setEditableMapShapes(current => [...current, shape]);
    setSelectedShapeId(shape.id);
    setShowBoundary(true);
    markJsonDirty();
  }

  function addLine() {
    const map = mapRef.current;
    if (!map) return;
    const center = map.latLngToContainerPoint(map.getCenter());
    const points = [-40,40].map(x => {
      const p = map.containerPointToLatLng(center.add([x,0]));
      return [roundCoordinate(p.lat), roundCoordinate(p.lng)] as LatLngTuple;
    });
    const segment: BoundarySegment = { id: `boundary-${crypto.randomUUID()}`, label: "New boundary", kind: "fullStreet", points, note: "" };
    setEditableBoundarySegments(current => [...current, segment]);
    setSelectedBoundarySegmentId(segment.id);
    setShowBoundary(true);
    markJsonDirty();
  }

  function splitLine() {
    if (!selectedBoundarySegment || selectedBoundaryPointIndex < 1 || selectedBoundaryPointIndex >= selectedBoundaryPointCount - 1) return;
    const index = selectedBoundaryPointIndex;
    const id = `boundary-${crypto.randomUUID()}`;
    setEditableBoundarySegments(current => current.flatMap(s => s.id !== selectedBoundarySegment.id ? [s] : [
      { ...s, points: s.points.slice(0, index + 1) },
      { ...s, id, label: `${s.label} (continued)`, points: s.points.slice(index) },
    ]));
    setSelectedBoundarySegmentId(id);
    markJsonDirty();
  }

  function snapPoint() {
    if (!selectedBoundarySegment) return;
    const match = nearestRoadPoint(selectedBoundarySegment.points[selectedBoundaryPointIndex], selectedRoad ? [selectedRoad] : roads, 80);
    if (!match) { setEditorStatus("No road within 80 m of this point."); return; }
    setEditableBoundarySegments(current => moveJoinedPoint(current, selectedBoundarySegment.id, selectedBoundaryPointIndex, match.point));
    setEditorStatus(`Point snapped to ${match.road.name}.`);
    markJsonDirty();
  }

  function snapLine() {
    if (!selectedBoundarySegment || !selectedRoad) return;
    try {
      const points = followRoad(selectedBoundarySegment.points, selectedRoad);
      setEditableBoundarySegments(current => replaceLine(current, selectedBoundarySegment.id, points));
      setSelectedBoundaryPointIndex(0);
      setEditorStatus(`Line follows ${selectedRoad.name} (${points.length} points).`);
      markJsonDirty();
    } catch (error) { setEditorStatus(error instanceof Error ? error.message : "Unable to snap this line."); }
  }

  function downloadJson() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(buildUpdatedConfig(), null, 2) + "\n"], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "eruvConfig.json";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setEditorStatus("JSON exported.");
  }

  async function importJson(file?: File) {
    if (!file) return;
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error("JSON must be smaller than 2 MB.");
      const next = parseConfig(await file.text());
      setLoadedConfig(next);
      setEditableBoundarySegments(structuredClone(next.boundarySegments));
      setEditableMapLabels(structuredClone(next.mapLabels));
      setEditableMapShapes(structuredClone(next.mapShapes));
      setPrintZoomPercent(next.map.printPreview.defaultZoomPercent);
      setSelectedBoundarySegmentId(next.boundarySegments[0].id);
      setSelectedMapLabelId(next.mapLabels[0]?.id ?? "");
      setSelectedShapeId("");
      markJsonDirty();
      setEditorStatus(`Imported ${file.name}.`);
      requestAnimationFrame(() => mapRef.current?.fitBounds(L.latLngBounds(next.boundarySegments.flatMap(s => s.points)), { padding: [40,40] }));
    } catch (error) { setEditorStatus(error instanceof Error ? error.message : "Unable to import JSON."); }
    if (importInputRef.current) importInputRef.current.value = "";
  }

  function openEditor() {
    setIsEditMode(true);
    setShowBoundary(true);
    setShowMarkers(true);
  }

  async function handlePrint() {
    setShowBoundary(true);
    setShowMarkers(true);
    await enterPrintPrep(printZoomPercent);
    window.print();
  }

  return (
    <>
      <main className={`app-shell${isEditMode && !isPrintPreview ? " editing" : ""}`}>
        <aside className="info-panel" aria-label="Brookwood eruv information">
        <section className="brand-block">
          <div className="brand-kicker">
            <ShieldCheck size={18} aria-hidden="true" />
            {config.kicker}
          </div>
          <h1>{config.title}</h1>
          <p>
            <span className="english-title">{config.englishTitle}</span>
            {config.subtitle}
          </p>
        </section>

        <section className="contact-strip" aria-label="Hotline">
          <Phone size={18} aria-hidden="true" />
          <span>Hotline</span>
          <a href={`tel:${config.hotline.replace(/[^\d+]/g, "")}`}>
            {config.hotline}
          </a>
        </section>

        <section className="vaad-card" aria-label="Vaad ha-eruv">
          <h2>{config.vaadTitle}</h2>
          <ul>
            {config.vaadMembers.map((member) => (
              <li key={member}>{member}</li>
            ))}
          </ul>
        </section>

        <section className="control-grid" aria-label="Map controls">
          <button type="button" onClick={() => fitToBoundary()}>
            <Crosshair size={17} aria-hidden="true" />
            Fit area
          </button>
          <button type="button" onClick={openPrintPreview}>
            <Printer size={17} aria-hidden="true" />
            Print letter
          </button>
          <button type="button" onClick={openEditor} className="full-action">
            <Pencil size={17} aria-hidden="true" /> Edit map
          </button>
          <button
            type="button"
            aria-pressed={showBoundary}
            onClick={() => setShowBoundary((current) => !current)}
          >
            <Route size={17} aria-hidden="true" />
            Boundary
          </button>
          <button
            type="button"
            aria-pressed={showMarkers}
            onClick={() => setShowMarkers((current) => !current)}
          >
            <MapPinned size={17} aria-hidden="true" />
            Markers
          </button>
        </section>

        <section className="legend-card" aria-label="Boundary legend">
          <div className="section-title">
            <Route size={17} aria-hidden="true" />
            Legend
          </div>
          {(Object.entries(boundaryStyles) as [BoundaryKind, typeof boundaryStyles[BoundaryKind]][]).map(
            ([kind, style]) => (
              <div className="legend-row" key={kind}>
                <span
                  className="legend-swatch"
                  style={{
                    "--swatch-color": style.color,
                    "--swatch-width": `${style.weight}px`,
                    "--swatch-print-width": `${Math.max(2.2, style.weight * 0.55)}pt`,
                    "--swatch-style":
                      kind === "fullStreet" ? "double" : kind === "innerSidewalkStreet"
                        ? "dotted"
                        : style.dashArray
                          ? "dashed"
                          : "solid",
                  } as CSSProperties}
                  aria-hidden="true"
                />
                <span>{style.label}</span>
              </div>
            ),
          )}
          <div className="legend-row marker-legend-row">
            <span className="legend-marker-dot" aria-hidden="true" />
            <span>{config.markerLegendLabel}</span>
          </div>
        </section>

        <section className="notice-card">
          <div className="section-title warning-title">
            <AlertTriangle size={17} aria-hidden="true" />
            Boundary Notes
          </div>
          <ul>
            {config.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </section>

        <details className="advanced-card">
          <summary>
            <Layers size={17} aria-hidden="true" />
            Advanced
          </summary>
          <div className="layer-card" aria-label="Basemap style">
            <div className="section-title">Basemap</div>
            <div className="segmented-control">
              {(Object.keys(baseLayers) as BaseLayerKey[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={baseLayer === key}
                  onClick={() => setBaseLayer(key)}
                >
                  {baseLayers[key].label}
                </button>
              ))}
            </div>
          </div>
        </details>
        </aside>

        <section className="map-stage" aria-label="Interactive eruv map">
          <div className="map-toolbar">
            <span>{config.areaLabel}</span>
            <span>{config.municipality}</span>
          </div>
          <div ref={mapNodeRef} className="map-canvas" />
        </section>
      </main>

      {isEditing ? (
        <aside className={isPrintPreview ? "print-preview-controls" : "editor-controls"} aria-label={isPrintPreview ? "Print preview controls" : "Map editor"}>
          <div className="print-preview-title">
            <SlidersHorizontal size={17} aria-hidden="true" />
            {isPrintPreview ? "Print preview" : "Edit map"}
            <button type="button" className="editor-close" title="Close editor" aria-label="Close editor" onClick={() => isPrintPreview ? closePrintPreview() : setIsEditMode(false)}><X size={18} /></button>
          </div>
          <div className="editor-commands" data-history-version={historyVersion}>
            <button type="button" title="Undo" aria-label="Undo" disabled={historyIndex.current <= 0} onClick={() => stepHistory(-1)}><Undo2 size={17}/></button>
            <button type="button" title="Redo" aria-label="Redo" disabled={historyIndex.current >= historyRef.current.length - 1} onClick={() => stepHistory(1)}><Redo2 size={17}/></button>
            <button type="button" title="Fit boundary" aria-label="Fit boundary" onClick={() => fitToBoundary(isPrintPreview)}><Crosshair size={17}/></button>
            {!isPrintPreview && <button type="button" title="Print preview" aria-label="Print preview" onClick={openPrintPreview}><Printer size={17}/></button>}
          </div>
          <label className="snap-toggle"><input type="checkbox" checked={isMapLocked} onChange={event => setIsMapLocked(event.currentTarget.checked)}/> Lock map position</label>
          <div className="editor-add-tools">
            <button type="button" onClick={addTextBox}><Plus size={15}/> Text box</button>
            <button type="button" onClick={addAreaBox}><Square size={15}/> Area box</button>
            <button type="button" onClick={addLine}><Route size={15}/> Line</button>
          </div>
          <div className="editor-files">
            <button type="button" onClick={downloadJson}><Download size={15}/> Export JSON</button>
            <button type="button" onClick={() => importInputRef.current?.click()}><Upload size={15}/> Import JSON</button>
            <input ref={importInputRef} type="file" accept=".json,application/json" aria-label="Import JSON file" hidden onChange={event => void importJson(event.currentTarget.files?.[0])}/>
          </div>
          {editorStatus && <p className="editor-status" role="status">{editorStatus}</p>}
          <label className="label-edit-select">
            <span>Map name</span>
            <input aria-label="Map name" type="text" value={config.areaLabel} maxLength={120} onChange={event => {
              const areaLabel = event.currentTarget.value;
              setLoadedConfig(current => ({ ...current, areaLabel }));
              markJsonDirty();
            }}/>
          </label>
          <section className="road-edit-tools" aria-label="Road snapping">
            <label className="snap-toggle"><input type="checkbox" checked={snapEnabled} onChange={event => setSnapEnabled(event.currentTarget.checked)}/><Magnet size={16}/> Snap while dragging</label>
            <label className="label-edit-select"><span>Snap road</span>
              <select value={selectedRoadId} onChange={event => setSelectedRoadId(event.currentTarget.value)}>
                <option value="">Any nearby road</option>
                {roads.map(road => <option key={road.id} value={road.id}>{road.name}{roads.filter(r => r.name === road.name).length > 1 ? ` (${road.id})` : ""}</option>)}
              </select>
            </label>
            <div className="editor-files">
              <button type="button" disabled={!selectedBoundarySegment} onClick={snapPoint}><Magnet size={15}/> Snap point</button>
              <button type="button" disabled={!selectedRoad || !selectedBoundarySegment} onClick={snapLine}><Route size={15}/> Follow road</button>
            </div>
          </section>
          {isPrintPreview && <div className="print-zoom-control">
            <div className="print-zoom-heading">
              <label htmlFor="print-zoom-range">Map zoom</label>
              <label className="print-zoom-value" htmlFor="print-zoom-number">
                <input
                  id="print-zoom-number"
                  type="number"
                  min={printPreviewDefaults.minZoomPercent}
                  max={printPreviewDefaults.maxZoomPercent}
                  step={printPreviewDefaults.stepPercent}
                  value={printZoomPercent}
                  onChange={(event) => updatePrintZoom(event.currentTarget.value)}
                />
                <span>%</span>
              </label>
            </div>
            <input
              id="print-zoom-range"
              type="range"
              min={printPreviewDefaults.minZoomPercent}
              max={printPreviewDefaults.maxZoomPercent}
              step={printPreviewDefaults.stepPercent}
              value={printZoomPercent}
              aria-label="Map zoom percent"
              onChange={(event) => updatePrintZoom(event.currentTarget.value)}
              onInput={(event) => updatePrintZoom(event.currentTarget.value)}
              onKeyUp={(event) => updatePrintZoom(event.currentTarget.value)}
            />
          </div>}
          {selectedMapLabel && selectedMapLabelTypography ? (
            <section className="label-edit-card" aria-label="Selected map label editor">
              <label className="label-edit-select">
                <span>Map label</span>
                <select
                  value={selectedMapLabel.id}
                  onChange={(event) =>
                    setSelectedMapLabelId(event.currentTarget.value)
                  }
                >
                  {editableMapLabels.map((label) => (
                    <option key={label.id} value={label.id}>
                      {label.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="label-edit-select"><span>Text</span>
                <textarea value={selectedMapLabel.label} rows={3} dir="auto" onChange={event => patchLabel({label: event.currentTarget.value})}/>
              </label>
              <div className="label-edit-grid">
                <label>
                  <span>Font size</span>
                  <input
                    type="number"
                    min={4}
                    max={18}
                    step={0.1}
                    value={selectedMapLabelTypography.fontSizePt}
                    onChange={(event) =>
                      updateSelectedMapLabelFontSize(event.currentTarget.value)
                    }
                  />
                  <small>pt</small>
                </label>
                <label>
                  <span>Weight</span>
                  <input
                    type="number"
                    min={300}
                    max={950}
                    step={50}
                    value={selectedMapLabelTypography.fontWeight}
                    onChange={(event) =>
                      updateSelectedMapLabelFontWeight(event.currentTarget.value)
                    }
                  />
                </label>
                <label><span>Width (px)</span><input type="number" min={20} max={500} value={selectedMapLabel.widthPx ?? 176} onChange={event => patchLabel({widthPx: clampNumber(Number(event.currentTarget.value),20,500)})}/></label>
                <label><span>Rotation</span><input type="number" min={-180} max={180} value={selectedMapLabel.rotationDeg ?? 0} onChange={event => patchLabel({rotationDeg: clampNumber(Number(event.currentTarget.value),-180,180)})}/></label>
                <label><span>Text color</span><input type="color" value={selectedMapLabel.color ?? "#1f2937"} onChange={event => patchLabel({color: event.currentTarget.value})}/></label>
                <label><span>Style</span><select value={selectedMapLabel.variant} onChange={event => patchLabel({variant: event.currentTarget.value as MapLabel["variant"]})}>
                  <option value="callout">Box</option><option value="plain">Plain</option><option value="handwritten">Handwritten</option>
                </select></label>
              </div>
              <button type="button" className="label-edit-reset" onClick={() => {setEditableMapLabels(current => current.filter(l => l.id !== selectedMapLabel.id)); markJsonDirty();}}><Trash2 size={15}/> Delete text box</button>
              <button
                type="button"
                className="label-edit-reset"
                onClick={resetSelectedMapLabelTypography}
              >
                <RotateCcw size={15} aria-hidden="true" />
                Reset selected label text
              </button>
            </section>
          ) : null}
          <section className="area-edit-tools" aria-label="Area boxes">
            <label className="label-edit-select"><span>Area box</span>
              <select value={selectedShapeId} onChange={event => setSelectedShapeId(event.currentTarget.value)}><option value="">Select area</option>{editableMapShapes.map(s => <option value={s.id} key={s.id}>{s.label}</option>)}</select>
            </label>
            {selectedShape && <>
              <label className="label-edit-select"><span>Area name</span><input value={selectedShape.label} onChange={event => {const label=event.currentTarget.value; setEditableMapShapes(current => current.map(s => s.id === selectedShape.id ? {...s,label} : s)); markJsonDirty();}}/></label>
              <button type="button" className="label-edit-reset" onClick={() => {setEditableMapShapes(current => current.filter(s => s.id !== selectedShape.id)); setSelectedShapeId(""); markJsonDirty();}}><Trash2 size={15}/> Delete area box</button>
            </>}
          </section>
          {selectedBoundarySegment ? (
            <section className="boundary-edit-card" aria-label="Selected boundary editor">
              <label className="label-edit-select">
                <span>Boundary line</span>
                <select
                  value={selectedBoundarySegment.id}
                  onChange={(event) =>
                    setSelectedBoundarySegmentId(event.currentTarget.value)
                  }
                >
                  {editableBoundarySegments.map((segment) => (
                    <option key={segment.id} value={segment.id}>
                      {segment.label}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" className="label-edit-reset" onClick={() => mapRef.current?.fitBounds(L.latLngBounds(selectedBoundarySegment.points).pad(0.25), {maxZoom:18,padding:[50,50]})}><Crosshair size={15}/> Focus selected line</button>
              <label className="label-edit-select">
                <span>Boundary type</span>
                <select
                  value={selectedBoundarySegment.kind}
                  onChange={(event) =>
                    updateSelectedBoundaryKind(
                      event.currentTarget.value as BoundaryKind,
                    )
                  }
                >
                  {(Object.entries(boundaryStyles) as [
                    BoundaryKind,
                    typeof boundaryStyles[BoundaryKind],
                  ][]).map(([kind, style]) => (
                    <option key={kind} value={kind}>
                      {style.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="boundary-point-tools">
                <label className="label-edit-select"><span>Point number</span><input type="number" min={1} max={selectedBoundaryPointCount} value={selectedBoundaryPointIndex + 1} onChange={event => setSelectedBoundaryPointIndex(Math.round(clampNumber(Number(event.currentTarget.value) - 1, 0, selectedBoundaryPointCount - 1)))}/></label>
                <span>
                  Point{" "}
                  {selectedBoundaryPointCount > 0
                    ? selectedBoundaryPointIndex + 1
                    : 0}{" "}
                  of {selectedBoundaryPointCount}
                </span>
                <div className="boundary-point-actions">
                  <button type="button" onClick={addBoundaryPoint}>
                    <Plus size={15} aria-hidden="true" />
                    Add point
                  </button>
                  <button
                    type="button"
                    disabled={selectedBoundaryPointCount <= 2}
                    onClick={removeBoundaryPoint}
                  >
                    <Trash2 size={15} aria-hidden="true" />
                    Remove
                  </button>
                </div>
              </div>
              <div className="editor-files">
                <button type="button" disabled={selectedBoundaryPointIndex < 1 || selectedBoundaryPointIndex >= selectedBoundaryPointCount - 1} onClick={splitLine}><Route size={15}/> Split at point</button>
                <button type="button" disabled={editableBoundarySegments.length <= 1} onClick={() => {setEditableBoundarySegments(current => current.filter(s => s.id !== selectedBoundarySegment.id)); markJsonDirty();}}><Trash2 size={15}/> Delete line</button>
              </div>
              <button
                type="button"
                className="label-edit-reset"
                onClick={resetBoundarySegments}
              >
                <RotateCcw size={15} aria-hidden="true" />
                Reset boundary lines
              </button>
            </section>
          ) : null}
          <div className="print-preview-actions">
            <button
              type="button"
              className="secondary-action"
              onClick={() => {
                setPrintZoomPercent(printPreviewDefaults.defaultZoomPercent);
                markJsonDirty();
              }}
            >
              <RotateCcw size={16} aria-hidden="true" />
              Reset zoom
            </button>
            <button
              type="button"
              className="secondary-action"
              onClick={resetMapLabels}
            >
              <RotateCcw size={16} aria-hidden="true" />
              Reset cards
            </button>
            <button
              type="button"
              className="secondary-action full-action"
              onClick={copyUpdatedJson}
            >
              {jsonCopyStatus === "Copied" ? (
                <Check size={16} aria-hidden="true" />
              ) : (
                <Copy size={16} aria-hidden="true" />
              )}
              {jsonCopyStatus}
            </button>
            {canSaveConfig ? (
              <button
                type="button"
                className="primary-action full-action"
                onClick={saveUpdatedJson}
              >
                {jsonSaveStatus === "Saved" ? (
                  <Check size={16} aria-hidden="true" />
                ) : (
                  <Save size={16} aria-hidden="true" />
                )}
                {jsonSaveStatus}
              </button>
            ) : null}
            {jsonSaveError ? (
              <p className="save-error-message">{jsonSaveError}</p>
            ) : null}
            {jsonOutput ? (
              <label className="json-output-field">
                Updated JSON
                <textarea
                  readOnly
                  value={jsonOutput}
                  onFocus={(event) => event.currentTarget.select()}
                />
              </label>
            ) : null}
            <button type="button" className="secondary-action" onClick={() => isPrintPreview ? closePrintPreview() : setIsEditMode(false)}>
              <X size={16} aria-hidden="true" />
              Close
            </button>
            <button type="button" className="primary-action" onClick={isPrintPreview ? handlePrint : openPrintPreview}>
              <Printer size={16} aria-hidden="true" />
              {isPrintPreview ? "Print" : "Print preview"}
            </button>
          </div>
        </aside>
      ) : null}
    </>
  );
}

export default App;
