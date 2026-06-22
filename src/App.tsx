import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  AlertTriangle,
  Check,
  Copy,
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
  boundaryFitPoints,
  boundaryMarkers,
  boundarySegments,
  boundaryStyles,
  eruvConfig,
  mapLabels,
  mapShapes,
  markerColors,
  type BoundaryKind,
  type BoundarySegment,
  type LatLngTuple,
  type MapLabel,
} from "./mapData";

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
  if (typeof window === "undefined") {
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
  const mapNodeRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const overlayRef = useRef<L.FeatureGroup | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  const [baseLayer, setBaseLayer] = useState<BaseLayerKey>("standard");
  const [showBoundary, setShowBoundary] = useState(true);
  const [showMarkers, setShowMarkers] = useState(true);
  const [isPrintPreview, setIsPrintPreview] = useState(false);
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
    () => L.latLngBounds(boundaryFitPoints.map(([lat, lng]) => [lat, lng])),
    [],
  );
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

    L.control.zoom({ position: "bottomright" }).addTo(map);
    const fitInitialView = () => {
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
  }, [mapBounds]);

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
      overlayRef.current.remove();
    }

    const group = L.featureGroup();

    if (showBoundary) {
      editableBoundarySegments.forEach((segment) => {
        const style = boundaryStyles[segment.kind];

        const boundaryLine = L.polyline(segment.points, {
          color: style.color,
          dashArray: style.dashArray,
          lineCap: "round",
          lineJoin: "round",
          opacity: 0.96,
          weight: style.weight,
        }).bindTooltip(`<strong>${segment.label}</strong><br />${segment.note}`, {
            sticky: true,
          });

        if (isPrintPreview) {
          boundaryLine.on("click", () => {
            setSelectedBoundarySegmentId(segment.id);
          });
        }

        boundaryLine.addTo(group);

        if (isPrintPreview && segment.id === selectedBoundarySegmentId) {
          segment.points.forEach((point, pointIndex) => {
            const isSelectedPoint = pointIndex === selectedBoundaryPointIndex;
            const vertexMarker = L.marker(point, {
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
              setSelectedBoundarySegmentId(segment.id);
              setSelectedBoundaryPointIndex(pointIndex);
            });

            vertexMarker.on("dragend", () => {
              const nextPosition = vertexMarker.getLatLng();

              setSelectedBoundarySegmentId(segment.id);
              setSelectedBoundaryPointIndex(pointIndex);
              setEditableBoundarySegments((currentSegments) =>
                currentSegments.map((currentSegment) =>
                  currentSegment.id === segment.id
                    ? {
                        ...currentSegment,
                        points: currentSegment.points.map(
                          (currentPoint, currentPointIndex) =>
                            currentPointIndex === pointIndex
                              ? [
                                  roundCoordinate(nextPosition.lat),
                                  roundCoordinate(nextPosition.lng),
                                ]
                              : currentPoint,
                        ),
                      }
                    : currentSegment,
                ),
              );
              markJsonDirty();
            });

            vertexMarker.addTo(group);
          });
        }
      });

      mapShapes.forEach((shape) => {
        L.polygon(shape.points, {
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
      });
    }

    if (showMarkers) {
      boundaryMarkers.forEach((marker) => {
        const markerLayer = L.circleMarker(marker.position, {
          radius: marker.type === "reference" ? 7 : 8,
          color: "#17212f",
          fillColor: markerColors[marker.type],
          fillOpacity: 1,
          opacity: 1,
          weight: 2,
        });

        markerLayer
          .bindTooltip(`<strong>${marker.label}</strong>`, {
            className: "marker-label",
            direction: "top",
            offset: [0, -8],
            permanent: true,
          })
          .bindPopup(`<strong>${marker.label}</strong><br />${marker.description}`)
          .addTo(group);
      });

      editableMapLabels.forEach((label) => {
        const isSelectedLabel = isPrintPreview && label.id === selectedMapLabelId;
        const iconWidth =
          label.variant === "callout"
            ? 176
            : label.variant === "handwritten"
              ? 84
              : 92;
        const iconHeight = label.variant === "callout" ? 64 : 24;

        const labelMarker = L.marker(label.position, {
          draggable: isPrintPreview,
          icon: L.divIcon({
            className: `map-text-label map-text-label-${label.variant}${
              isPrintPreview ? " map-label-editing" : ""
            }${isSelectedLabel ? " map-label-selected" : ""}`,
            html: `<span class="map-label-box"${getMapLabelBoxStyle(label)}>${escapeHtml(
              label.label,
            )}</span>`,
            iconAnchor: [iconWidth / 2, 0],
            iconSize: [iconWidth, iconHeight],
          }),
          interactive: isPrintPreview,
        });

        if (isPrintPreview) {
          labelMarker.on("click", () => {
            setSelectedMapLabelId(label.id);
          });

          labelMarker.on("dragstart", () => {
            setSelectedMapLabelId(label.id);
          });

          labelMarker.on("dragend", () => {
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
  }, [
    editableBoundarySegments,
    editableMapLabels,
    isPrintPreview,
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
        const bounds = mapBounds.pad(eruvConfig.map.printFitPaddingRatio);
        const fitZoom = map.getBoundsZoom(bounds, false, printPadding);
        const zoomOffset = (zoomPercent - 100) / 25;
        const nextZoom = Math.min(
          map.getMaxZoom(),
          Math.max(map.getMinZoom(), fitZoom + zoomOffset),
        );

        map.setView(bounds.getCenter(), nextZoom, { animate: false });
        return;
      }

      map.fitBounds(mapBounds.pad(eruvConfig.map.screenFitPaddingRatio), {
        animate: false,
        padding: [44, 44],
      });
    },
    [mapBounds, printZoomPercent],
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
            ? { ...segment, kind: value }
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
    setEditableBoundarySegments(cloneBoundarySegments());
    setSelectedBoundaryPointIndex(0);
    markJsonDirty();
  }, [markJsonDirty]);

  const resetMapLabels = useCallback(() => {
    setEditableMapLabels(cloneMapLabels());
    markJsonDirty();
  }, [markJsonDirty]);

  const buildUpdatedConfig = useCallback(
    () => ({
      ...eruvConfig,
      map: {
        ...eruvConfig.map,
        printPreview: {
          ...eruvConfig.map.printPreview,
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
    [editableBoundarySegments, editableMapLabels, printZoomPercent],
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


  async function handlePrint() {
    setShowBoundary(true);
    setShowMarkers(true);
    await enterPrintPrep(printZoomPercent);
    window.print();
  }

  return (
    <>
      <main className="app-shell">
        <aside className="info-panel" aria-label="Brookwood eruv information">
        <section className="brand-block">
          <div className="brand-kicker">
            <ShieldCheck size={18} aria-hidden="true" />
            {eruvConfig.kicker}
          </div>
          <h1>{eruvConfig.title}</h1>
          <p>
            <span className="english-title">{eruvConfig.englishTitle}</span>
            {eruvConfig.subtitle}
          </p>
        </section>

        <section className="contact-strip" aria-label="Hotline">
          <Phone size={18} aria-hidden="true" />
          <span>Hotline</span>
          <a href={`tel:${eruvConfig.hotline.replace(/-/g, "")}`}>
            {eruvConfig.hotline}
          </a>
        </section>

        <section className="vaad-card" aria-label="Vaad ha-eruv">
          <h2>{eruvConfig.vaadTitle}</h2>
          <ul>
            {eruvConfig.vaadMembers.map((member) => (
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
                      style.dashArray === "1 10"
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
            <span>{eruvConfig.markerLegendLabel}</span>
          </div>
        </section>

        <section className="notice-card">
          <div className="section-title warning-title">
            <AlertTriangle size={17} aria-hidden="true" />
            Boundary Notes
          </div>
          <ul>
            {eruvConfig.notes.map((note) => (
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
            <span>{eruvConfig.areaLabel}</span>
            <span>{eruvConfig.municipality}</span>
          </div>
          <div ref={mapNodeRef} className="map-canvas" />
        </section>
      </main>

      {isPrintPreview ? (
        <aside className="print-preview-controls" aria-label="Print preview controls">
          <div className="print-preview-title">
            <SlidersHorizontal size={17} aria-hidden="true" />
            Print preview
          </div>
          <p className="print-preview-hint">
            Drag the map info cards, adjust selected label text, then copy the
            updated JSON.
          </p>
          <div className="print-zoom-control">
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
          </div>
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
              </div>
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
              <p className="boundary-edit-hint">
                Drag numbered points, or add/remove the selected point.
              </p>
              <div className="boundary-point-tools">
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
            <button type="button" className="secondary-action" onClick={closePrintPreview}>
              <X size={16} aria-hidden="true" />
              Close
            </button>
            <button type="button" className="primary-action" onClick={handlePrint}>
              <Printer size={16} aria-hidden="true" />
              Print
            </button>
          </div>
        </aside>
      ) : null}
    </>
  );
}

export default App;
