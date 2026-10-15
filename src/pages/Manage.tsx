import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ChangeEvent,
  FormEvent,
  ReactNode,
  PointerEvent as ReactPointerEvent,
} from "react";
import { Link } from "react-router-dom";
import {
  type CreativeSubmissionMetadata,
  type ManagedCreative,
  type ManagedPlot,
  api,
} from "../lib/api";

const MAX_SOURCE_BYTES = 35 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 4.4 * 1024 * 1024;
const MAX_IMAGE_SIDE = 1920;
const MAX_IMAGE_PIXELS = 80_000_000;

const SUPPORTED_IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const ZOOM_LEVELS = [1, 2, 4, 8, 12, 16] as const;

type PlacementMode = "select" | "move" | "resize" | "pan";
type DraftStatus = "draft" | "submitting" | "submitted" | "error";
type AssetFilter = "all" | "placement" | "attention" | "submitted";
type ConfirmationAction = "close" | "clear";

interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface GridPoint {
  x: number;
  y: number;
}

interface BrickCell {
  id: number;
  x: number;
}

interface CreativeDraft {
  id: string;
  originalName: string;
  file: File | null;
  previewUrl: string | null;
  storagePath: string | null;
  region: Region | null;
  category: string;
  intendedAudience: string;
  destinationUrl: string;
  status: DraftStatus;
  creativeId: string | null;
  error: string | null;
  /** Exact assigned cells for creatives restored from the database. */
  assignedBrickIds: number[] | null;
  reviewStatus: "pending" | "approved" | "rejected" | null;
}

interface DragState {
  draftId: string | null;
  kind: PlacementMode;
  pointerId: number;
  start: GridPoint;
  original: Region | null;
  startCenter: GridPoint;
  startClientX: number;
  startClientY: number;
  screenScale: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clampViewCenter(
  center: GridPoint,
  width: number,
  height: number,
  zoom: number,
): GridPoint {
  const visibleWidth = width / zoom;
  const visibleHeight = height / zoom;

  return {
    x: clamp(center.x, visibleWidth / 2, width - visibleWidth / 2),
    y: clamp(center.y, visibleHeight / 2, height - visibleHeight / 2),
  };
}

function createId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("Your browser could not prepare this image."));
          return;
        }

        resolve(blob);
      },
      "image/webp",
      quality,
    );
  });
}

/** Prepare an image for upload without exposing technical details in the UI. */
async function compressCreativeImage(source: File): Promise<File> {
  const sourceType = source.type.toLowerCase();
  const sourceExtension = source.name.split(".").pop()?.toLowerCase() ?? "";
  const supportedByExtension = ["jpg", "jpeg", "png", "webp"].includes(
    sourceExtension,
  );

  if (
    !SUPPORTED_IMAGE_TYPES[sourceType] &&
    !(sourceType === "" && supportedByExtension)
  ) {
    throw new Error("Use a JPEG, PNG, or WebP image.");
  }

  if (source.size <= 0 || source.size > MAX_SOURCE_BYTES) {
    throw new Error("Choose an image smaller than 35 MB.");
  }

  let bitmap: ImageBitmap;

  try {
    bitmap = await createImageBitmap(source);
  } catch {
    throw new Error("This image could not be opened. Try another file.");
  }

  try {
    if (bitmap.width <= 0 || bitmap.height <= 0) {
      throw new Error("This image has invalid dimensions.");
    }

    if (bitmap.width * bitmap.height > MAX_IMAGE_PIXELS) {
      throw new Error(
        "This image is too large to process safely. Resize it first.",
      );
    }

    let scale = Math.min(
      1,
      MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height),
    );

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { alpha: true });

    if (!context) {
      throw new Error("Image preparation is not supported by this browser.");
    }

    for (let attempt = 0; attempt < 9; attempt += 1) {
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));

      canvas.width = width;
      canvas.height = height;
      context.clearRect(0, 0, width, height);
      context.drawImage(bitmap, 0, 0, width, height);

      for (const quality of [0.86, 0.78, 0.7, 0.62]) {
        const blob = await canvasToBlob(canvas, quality);
        const mimeType = blob.type || "image/webp";
        const extension = SUPPORTED_IMAGE_TYPES[mimeType];

        if (extension && blob.size <= MAX_UPLOAD_BYTES) {
          const basename =
            source.name.replace(/\.[^.]+$/, "").trim() || "creative";
          return new File([blob], `${basename}.${extension}`, {
            type: mimeType,
            lastModified: Date.now(),
          });
        }
      }

      if (Math.max(width, height) <= 512) break;
      scale *= 0.8;
    }

    throw new Error(
      "This image could not be prepared for upload. Try a smaller image.",
    );
  } finally {
    bitmap.close();
  }
}

function getBricksInsideRegion(
  rows: Map<number, BrickCell[]>,
  region: Region | null,
): number[] {
  if (!region) return [];

  const result: number[] = [];
  const bottom = region.y + region.height;
  const right = region.x + region.width;

  for (let y = region.y; y < bottom; y += 1) {
    const row = rows.get(y);
    if (!row) continue;

    for (const brick of row) {
      if (brick.x >= region.x && brick.x < right) result.push(brick.id);
    }
  }

  return result;
}

function getRegionForBrickIds(
  ids: number[],
  plotMinX: number,
  plotMinY: number,
): Region | null {
  if (ids.length === 0) return null;

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const id of ids) {
    const x = (id % 1000) - plotMinX;
    const y = Math.floor(id / 1000) - plotMinY;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

function getBrickNeighbors(id: number): number[] {
  const x = id % 1000;
  const y = Math.floor(id / 1000);
  const neighbors: number[] = [];

  if (x > 0) neighbors.push(id - 1);
  if (x < 999) neighbors.push(id + 1);
  if (y > 0) neighbors.push(id - 1000);
  if (y < 999) neighbors.push(id + 1000);

  return neighbors;
}

function areBricksConnected(ids: number[]): boolean {
  if (ids.length === 0) return false;
  if (ids.length === 1) return true;

  const idSet = new Set(ids);
  const visited = new Set<number>([ids[0]]);
  const queue = [ids[0]];

  for (let index = 0; index < queue.length; index += 1) {
    for (const neighbor of getBrickNeighbors(queue[index])) {
      if (idSet.has(neighbor) && !visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }

  return visited.size === idSet.size;
}

function validateMetadata(draft: CreativeDraft): string | null {
  const category = draft.category.trim();
  const audience = draft.intendedAudience.trim();
  const destination = draft.destinationUrl.trim();

  if (category.length < 2 || category.length > 60) {
    return "Category must be between 2 and 60 characters.";
  }

  if (audience.length < 2 || audience.length > 300) {
    return "Intended audience must be between 2 and 300 characters.";
  }

  if (destination.length > 2048) {
    return "Destination URL must be 2,048 characters or fewer.";
  }

  try {
    const url = new URL(destination);

    if (
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password
    ) {
      return "Enter a valid HTTPS destination without embedded credentials.";
    }
  } catch {
    return "Enter a valid HTTPS destination.";
  }

  return null;
}

function matchesFilter(
  draft: CreativeDraft,
  filter: AssetFilter,
  issues: Map<string, string | null>,
): boolean {
  const unresolved =
    draft.status !== "submitted" && draft.status !== "submitting";

  switch (filter) {
    case "placement":
      return (
        unresolved && (!draft.region || (!draft.file && !draft.storagePath))
      );
    case "attention":
      return (
        unresolved &&
        (draft.status === "error" ||
          (draft.region !== null && issues.get(draft.id) != null))
      );
    case "submitted":
      return draft.status === "submitted";
    default:
      return true;
  }
}

function StatusPill({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "positive" | "warning" | "danger";
}) {
  const styles = {
    neutral: "border-white/10 bg-white/[0.04] text-neutral-400",
    positive: "border-white/15 bg-white/[0.07] text-neutral-200",
    warning: "border-neutral-700 bg-neutral-900 text-neutral-300",
    danger: "border-neutral-700 bg-neutral-900 text-neutral-200",
  };

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-medium tracking-wide ${styles[tone]}`}
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 rounded-full ${tone === "positive" ? "bg-neutral-200" : tone === "warning" ? "bg-neutral-500" : tone === "danger" ? "bg-white" : "bg-neutral-600"}`}
      />
      {children}
    </span>
  );
}

function PlotPreview({ plot }: { plot: ManagedPlot }) {
  const path = plot.brickIds
    .map((id) => {
      const x = (id % 1000) - plot.minX;
      const y = Math.floor(id / 1000) - plot.minY;
      return `M${x},${y} h1 v1 h-1 Z`;
    })
    .join(" ");

  return (
    <svg
      role="img"
      aria-label={`Shape of Plot ${plot.plotKey}`}
      viewBox={`0 0 ${Math.max(1, plot.width)} ${Math.max(1, plot.height)}`}
      className="h-full w-full"
      preserveAspectRatio="xMidYMid meet"
    >
      <title>{`Plot ${plot.plotKey}`}</title>
      <path d={path} fill="#d4d4d4" />
    </svg>
  );
}

function CreativeWorkspace({
  plot,
  onClose,
  onSubmitted,
}: {
  plot: ManagedPlot;
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const objectUrlsRef = useRef(new Set<string>());
  const loadSequenceRef = useRef(0);

  const componentId = useId().replace(/[^a-zA-Z0-9_-]/g, "");

  const [drafts, setDrafts] = useState<CreativeDraft[]>([]);
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null);
  const [placementMode, setPlacementMode] = useState<PlacementMode>("select");
  const [zoomIndex, setZoomIndex] = useState(0);
  const [viewCenter, setViewCenter] = useState<GridPoint>({
    x: plot.width / 2,
    y: plot.height / 2,
  });
  const [searchQuery, setSearchQuery] = useState("");
  const [assetFilter, setAssetFilter] = useState<AssetFilter>("all");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isCompressing, setIsCompressing] = useState(false);
  const [isLoadingAssignedCreatives, setIsLoadingAssignedCreatives] =
    useState(true);
  const [assignedCreativesError, setAssignedCreativesError] = useState<
    string | null
  >(null);
  const [compressionProgress, setCompressionProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [batchMessage, setBatchMessage] = useState<string | null>(null);
  const [confirmationAction, setConfirmationAction] =
    useState<ConfirmationAction | null>(null);

  const activeDraft =
    drafts.find((draft) => draft.id === activeDraftId) ?? null;
  const editableActive =
    activeDraft !== null &&
    activeDraft.status !== "submitted" &&
    activeDraft.status !== "submitting";
  const zoom = ZOOM_LEVELS[zoomIndex];
  const viewWidth = plot.width / zoom;
  const viewHeight = plot.height / zoom;
  const viewLeft = clamp(
    viewCenter.x - viewWidth / 2,
    0,
    Math.max(0, plot.width - viewWidth),
  );
  const viewTop = clamp(
    viewCenter.y - viewHeight / 2,
    0,
    Math.max(0, plot.height - viewHeight),
  );
  const viewBox = `${viewLeft} ${viewTop} ${viewWidth} ${viewHeight}`;

  const revokeObjectUrl = useCallback((url: string | null) => {
    if (url && objectUrlsRef.current.delete(url)) URL.revokeObjectURL(url);
  }, []);

  const createObjectUrl = useCallback((file: File) => {
    const url = URL.createObjectURL(file);
    objectUrlsRef.current.add(url);
    return url;
  }, []);

  useEffect(
    () => () => {
      for (const url of objectUrlsRef.current) URL.revokeObjectURL(url);
      objectUrlsRef.current.clear();
    },
    [],
  );

  useEffect(() => {
    if (!confirmationAction) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setConfirmationAction(null);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [confirmationAction]);

  const brickRows = useMemo(() => {
    const rows = new Map<number, BrickCell[]>();

    for (const id of plot.brickIds) {
      const x = (id % 1000) - plot.minX;
      const y = Math.floor(id / 1000) - plot.minY;
      const row = rows.get(y) ?? [];
      row.push({ id, x });
      rows.set(y, row);
    }

    return rows;
  }, [plot.brickIds, plot.minX, plot.minY]);

  const loadAssignedCreatives = useCallback(async () => {
    const requestId = ++loadSequenceRef.current;
    setIsLoadingAssignedCreatives(true);
    setAssignedCreativesError(null);

    try {
      const savedCreatives: ManagedCreative[] =
        await api.getMyAssignedCreatives(plot.brickIds);
      if (requestId !== loadSequenceRef.current) return;

      const plotBrickIds = new Set(plot.brickIds);
      const restoredDrafts: CreativeDraft[] = savedCreatives
        .map((creative) => {
          const assignedBrickIds = creative.brickIds.filter((id) =>
            plotBrickIds.has(id),
          );
          const reviewStatus =
            creative.status === "approved"
              ? ("approved" as const)
              : creative.status === "rejected"
                ? ("rejected" as const)
                : ("pending" as const);
          const label =
            creative.category?.trim() ||
            `${reviewStatus === "approved" ? "Live creative" : "Creative"} ${creative.id.slice(0, 8)}`;

          return {
            id: creative.id,
            originalName: label,
            file: null,
            previewUrl: creative.previewUrl,
            storagePath: creative.uploadStoragePath,
            region: getRegionForBrickIds(
              assignedBrickIds,
              plot.minX,
              plot.minY,
            ),
            category: creative.category ?? "",
            intendedAudience: creative.intendedAudience ?? "",
            destinationUrl: creative.destinationUrl ?? "",
            status: "submitted" as const,
            creativeId: creative.id,
            error: null,
            assignedBrickIds,
            reviewStatus,
          };
        })
        .filter(
          (draft) =>
            draft.assignedBrickIds !== null &&
            draft.assignedBrickIds.length > 0,
        );

      const persistedIds = new Set(
        restoredDrafts.map((draft) => draft.creativeId),
      );
      setDrafts((current) => {
        const unfinishedLocalDrafts = current.filter(
          (draft) =>
            draft.reviewStatus === null &&
            !(draft.creativeId && persistedIds.has(draft.creativeId)),
        );
        return [...restoredDrafts, ...unfinishedLocalDrafts];
      });

      const preferredId =
        restoredDrafts.find((draft) => draft.reviewStatus === "pending")?.id ??
        restoredDrafts[0]?.id ??
        null;
      // Focus the restored pending creative first. If none exists, the library
      // selection effect will choose the first available live creative or draft.
      setActiveDraftId(preferredId);
    } catch (error) {
      if (requestId !== loadSequenceRef.current) return;
      setAssignedCreativesError(
        error instanceof Error
          ? error.message
          : "Saved creatives could not be restored. Please try again.",
      );
    } finally {
      if (requestId === loadSequenceRef.current) {
        setIsLoadingAssignedCreatives(false);
      }
    }
  }, [plot.brickIds, plot.minX, plot.minY]);

  useEffect(() => {
    void loadAssignedCreatives();
    return () => {
      loadSequenceRef.current += 1;
    };
  }, [loadAssignedCreatives]);

  const patchDraft = useCallback(
    (id: string, patch: Partial<CreativeDraft>) => {
      setDrafts((current) =>
        current.map((draft) =>
          draft.id === id ? { ...draft, ...patch } : draft,
        ),
      );
    },
    [],
  );

  const patchEditableDraft = useCallback(
    (id: string, patch: Partial<CreativeDraft>) => {
      patchDraft(id, { ...patch, status: "draft", error: null });
      setFormError(null);
      setBatchMessage(null);
    },
    [patchDraft],
  );

  const idsByDraft = useMemo(() => {
    const result = new Map<string, number[]>();
    const plotBrickIds = new Set(plot.brickIds);
    for (const draft of drafts) {
      const ids =
        draft.assignedBrickIds !== null
          ? draft.assignedBrickIds.filter((id) => plotBrickIds.has(id))
          : getBricksInsideRegion(brickRows, draft.region);
      result.set(draft.id, ids);
    }
    return result;
  }, [drafts, brickRows, plot.brickIds]);

  const draftIssues = useMemo(() => {
    const issues = new Map<string, string | null>();
    const ownersByBrick = new Map<number, string[]>();

    // Submitted drafts are immutable history. They should not block a later
    // replacement draft after the server has cleared its pending assignment.
    for (const draft of drafts) {
      if (draft.status === "submitted" || draft.status === "submitting")
        continue;
      for (const id of idsByDraft.get(draft.id) ?? []) {
        const owners = ownersByBrick.get(id) ?? [];
        owners.push(draft.id);
        ownersByBrick.set(id, owners);
      }
    }

    for (const draft of drafts) {
      if (draft.status === "submitted" || draft.status === "submitting") {
        issues.set(draft.id, null);
        continue;
      }
      if (!draft.file && !draft.storagePath) {
        issues.set(draft.id, "Add an image.");
        continue;
      }
      if (!draft.region) {
        issues.set(draft.id, "Place this image on the canvas.");
        continue;
      }

      const ids = idsByDraft.get(draft.id) ?? [];
      if (ids.length === 0) {
        issues.set(draft.id, "No owned Bricks are covered.");
        continue;
      }
      if (!areBricksConnected(ids)) {
        issues.set(draft.id, "This region contains disconnected Bricks.");
        continue;
      }

      const overlaps = ids.some((id) =>
        (ownersByBrick.get(id) ?? []).some((ownerId) => ownerId !== draft.id),
      );
      if (overlaps) {
        issues.set(
          draft.id,
          "This region overlaps another unfinished creative. Give each pending creative its own Bricks.",
        );
        continue;
      }

      issues.set(draft.id, validateMetadata(draft));
    }

    return issues;
  }, [drafts, idsByDraft]);

  const readyCount = drafts.filter(
    (draft) =>
      draft.status !== "submitted" &&
      draft.status !== "submitting" &&
      draftIssues.get(draft.id) === null,
  ).length;
  const submittedCount = drafts.filter(
    (draft) => draft.status === "submitted",
  ).length;
  const unsentCount = drafts.filter(
    (draft) => draft.status !== "submitted",
  ).length;

  const visibleDrafts = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return drafts.filter((draft) => {
      if (
        query &&
        !`${draft.originalName} ${draft.category}`.toLowerCase().includes(query)
      )
        return false;
      return matchesFilter(draft, assetFilter, draftIssues);
    });
  }, [drafts, searchQuery, assetFilter, draftIssues]);

  const filterCounts = useMemo(() => {
    const counts: Record<AssetFilter, number> = {
      all: drafts.length,
      placement: 0,
      attention: 0,
      submitted: 0,
    };
    for (const draft of drafts) {
      if (matchesFilter(draft, "placement", draftIssues)) counts.placement += 1;
      if (matchesFilter(draft, "attention", draftIssues)) counts.attention += 1;
      if (matchesFilter(draft, "submitted", draftIssues)) counts.submitted += 1;
    }
    return counts;
  }, [drafts, draftIssues]);

  useEffect(() => {
    if (
      activeDraftId &&
      visibleDrafts.some((draft) => draft.id === activeDraftId)
    )
      return;
    setActiveDraftId(visibleDrafts[0]?.id ?? null);
  }, [visibleDrafts, activeDraftId]);

  const getGridPoint = useCallback(
    (
      event: ReactPointerEvent<SVGSVGElement>,
      clampOutside: boolean,
    ): GridPoint | null => {
      const svg = svgRef.current;
      const matrix = svg?.getScreenCTM();
      if (!svg || !matrix) return null;

      let point: DOMPoint;
      try {
        point = new DOMPoint(event.clientX, event.clientY).matrixTransform(
          matrix.inverse(),
        );
      } catch {
        return null;
      }

      if (
        !clampOutside &&
        (point.x < viewLeft ||
          point.y < viewTop ||
          point.x >= viewLeft + viewWidth ||
          point.y >= viewTop + viewHeight)
      )
        return null;

      return {
        x: clamp(
          Math.floor(point.x),
          Math.floor(viewLeft),
          Math.min(plot.width - 1, Math.ceil(viewLeft + viewWidth) - 1),
        ),
        y: clamp(
          Math.floor(point.y),
          Math.floor(viewTop),
          Math.min(plot.height - 1, Math.ceil(viewTop + viewHeight) - 1),
        ),
      };
    },
    [plot.width, plot.height, viewLeft, viewTop, viewWidth, viewHeight],
  );

  const handlePointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (
      isSubmitting ||
      isCompressing ||
      isLoadingAssignedCreatives ||
      event.button !== 0
    )
      return;
    const point = getGridPoint(event, false);
    if (!point) return;

    if (placementMode === "pan") {
      const bounds = event.currentTarget.getBoundingClientRect();
      const screenScale = Math.min(
        bounds.width / viewWidth,
        bounds.height / viewHeight,
      );
      dragRef.current = {
        draftId: null,
        kind: "pan",
        pointerId: event.pointerId,
        start: point,
        original: null,
        startCenter: viewCenter,
        startClientX: event.clientX,
        startClientY: event.clientY,
        screenScale,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }

    if (!activeDraft || !editableActive) return;

    if (placementMode === "resize") {
      const target =
        event.target instanceof Element
          ? event.target.closest('[data-resize-handle="true"]')
          : null;
      if (!activeDraft.region || !target) return;
    }

    if (placementMode === "move") {
      const region = activeDraft.region;
      if (
        !region ||
        point.x < region.x ||
        point.x >= region.x + region.width ||
        point.y < region.y ||
        point.y >= region.y + region.height
      )
        return;
    }

    dragRef.current = {
      draftId: activeDraft.id,
      kind: placementMode,
      pointerId: event.pointerId,
      start: point,
      original: activeDraft.region ? { ...activeDraft.region } : null,
      startCenter: viewCenter,
      startClientX: event.clientX,
      startClientY: event.clientY,
      screenScale: 1,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();

    if (placementMode === "select") {
      patchEditableDraft(activeDraft.id, {
        region: { x: point.x, y: point.y, width: 1, height: 1 },
      });
    }
  };

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (
      !drag ||
      drag.pointerId !== event.pointerId ||
      isSubmitting ||
      isCompressing ||
      isLoadingAssignedCreatives
    )
      return;

    if (drag.kind === "pan") {
      if (drag.screenScale <= 0) return;
      const dx = (event.clientX - drag.startClientX) / drag.screenScale;
      const dy = (event.clientY - drag.startClientY) / drag.screenScale;
      setViewCenter(
        clampViewCenter(
          { x: drag.startCenter.x - dx, y: drag.startCenter.y - dy },
          plot.width,
          plot.height,
          zoom,
        ),
      );
      return;
    }

    const current = getGridPoint(event, true);
    if (!current || !drag.draftId) return;

    if (drag.kind === "select") {
      patchEditableDraft(drag.draftId, {
        region: {
          x: Math.min(drag.start.x, current.x),
          y: Math.min(drag.start.y, current.y),
          width: Math.abs(current.x - drag.start.x) + 1,
          height: Math.abs(current.y - drag.start.y) + 1,
        },
      });
      return;
    }

    if (!drag.original) return;

    if (drag.kind === "move") {
      patchEditableDraft(drag.draftId, {
        region: {
          ...drag.original,
          x: clamp(
            drag.original.x + current.x - drag.start.x,
            0,
            plot.width - drag.original.width,
          ),
          y: clamp(
            drag.original.y + current.y - drag.start.y,
            0,
            plot.height - drag.original.height,
          ),
        },
      });
      return;
    }

    if (drag.kind === "resize") {
      patchEditableDraft(drag.draftId, {
        region: {
          ...drag.original,
          width: clamp(
            drag.original.width + current.x - drag.start.x,
            1,
            plot.width - drag.original.x,
          ),
          height: clamp(
            drag.original.height + current.y - drag.start.y,
            1,
            plot.height - drag.original.y,
          ),
        },
      });
    }
  };

  const finishPointerAction = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  };

  const handleAddImages = async (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (selectedFiles.length === 0) return;

    setIsCompressing(true);
    setCompressionProgress({ done: 0, total: selectedFiles.length });
    setFormError(null);
    setBatchMessage(null);

    const added: CreativeDraft[] = [];
    const rejected: string[] = [];

    try {
      for (let index = 0; index < selectedFiles.length; index += 1) {
        const source = selectedFiles[index];
        setCompressionProgress({ done: index, total: selectedFiles.length });

        try {
          const file = await compressCreativeImage(source);
          added.push({
            id: createId(),
            originalName: source.name,
            file,
            previewUrl: createObjectUrl(file),
            storagePath: null,
            region: null,
            category: "",
            intendedAudience: "",
            destinationUrl: "",
            status: "draft",
            creativeId: null,
            error: null,
            assignedBrickIds: null,
            reviewStatus: null,
          });
        } catch (error) {
          rejected.push(
            `${source.name}: ${error instanceof Error ? error.message : "This image could not be added."}`,
          );
        }

        setCompressionProgress({
          done: index + 1,
          total: selectedFiles.length,
        });
      }

      if (added.length > 0) {
        setDrafts((current) => [...current, ...added]);
        setActiveDraftId(added[0].id);
        setPlacementMode("select");
        setAssetFilter("all");
        setSearchQuery("");
      }

      if (rejected.length > 0) {
        setFormError(
          rejected.length === selectedFiles.length
            ? rejected.join(" ")
            : `${rejected.length} image${rejected.length === 1 ? "" : "s"} could not be added. ${rejected.join(" ")}`,
        );
      }
    } finally {
      setCompressionProgress(null);
      setIsCompressing(false);
    }
  };

  const handleReplaceImage = async (event: ChangeEvent<HTMLInputElement>) => {
    const source = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!source || !activeDraft || !editableActive) return;

    const targetDraftId = activeDraft.id;
    setIsCompressing(true);
    setCompressionProgress({ done: 0, total: 1 });
    setFormError(null);

    try {
      const file = await compressCreativeImage(source);
      const previewUrl = createObjectUrl(file);
      const currentTarget = drafts.find((draft) => draft.id === targetDraftId);
      if (
        !currentTarget ||
        currentTarget.status === "submitted" ||
        currentTarget.status === "submitting"
      ) {
        revokeObjectUrl(previewUrl);
        return;
      }
      revokeObjectUrl(currentTarget.previewUrl);
      patchEditableDraft(targetDraftId, {
        originalName: source.name,
        file,
        previewUrl,
        storagePath: null,
      });
    } catch (error) {
      setFormError(
        error instanceof Error
          ? error.message
          : "This image could not be replaced.",
      );
    } finally {
      setCompressionProgress(null);
      setIsCompressing(false);
    }
  };

  const handleRemoveDraft = (draft: CreativeDraft) => {
    if (
      isSubmitting ||
      isCompressing ||
      isLoadingAssignedCreatives ||
      draft.status === "submitted" ||
      draft.status === "submitting"
    )
      return;
    revokeObjectUrl(draft.previewUrl);
    const remaining = drafts.filter((item) => item.id !== draft.id);
    setDrafts(remaining);
    if (activeDraftId === draft.id) setActiveDraftId(remaining[0]?.id ?? null);
    setFormError(null);
    setBatchMessage(null);
  };

  const handleClearRegion = () => {
    if (
      !activeDraft ||
      !editableActive ||
      isSubmitting ||
      isCompressing ||
      isLoadingAssignedCreatives
    )
      return;
    dragRef.current = null;
    patchEditableDraft(activeDraft.id, { region: null });
    setPlacementMode("select");
  };

  const handleSelectEntirePlot = () => {
    if (
      !activeDraft ||
      !editableActive ||
      isSubmitting ||
      isCompressing ||
      isLoadingAssignedCreatives
    )
      return;
    dragRef.current = null;
    patchEditableDraft(activeDraft.id, {
      region: { x: 0, y: 0, width: plot.width, height: plot.height },
    });
    setPlacementMode("select");
  };

  const handleZoom = (direction: -1 | 1) => {
    const nextIndex = clamp(zoomIndex + direction, 0, ZOOM_LEVELS.length - 1);
    const nextZoom = ZOOM_LEVELS[nextIndex];
    const focus = activeDraft?.region
      ? {
          x: activeDraft.region.x + activeDraft.region.width / 2,
          y: activeDraft.region.y + activeDraft.region.height / 2,
        }
      : viewCenter;
    dragRef.current = null;
    setZoomIndex(nextIndex);
    setViewCenter(clampViewCenter(focus, plot.width, plot.height, nextZoom));
  };

  const handleFitPlot = () => {
    dragRef.current = null;
    setZoomIndex(0);
    setViewCenter({ x: plot.width / 2, y: plot.height / 2 });
  };

  const requestClose = () => {
    if (isSubmitting || isCompressing || isLoadingAssignedCreatives) return;
    if (unsentCount > 0) setConfirmationAction("close");
    else onClose();
  };

  const requestClearDrafts = () => {
    if (isSubmitting || isCompressing || isLoadingAssignedCreatives) return;
    const removable = drafts.some(
      (draft) => draft.status !== "submitted" && draft.status !== "submitting",
    );
    if (removable) setConfirmationAction("clear");
  };

  const confirmDialogAction = () => {
    if (confirmationAction === "close") {
      setConfirmationAction(null);
      onClose();
      return;
    }

    if (confirmationAction === "clear") {
      const kept = drafts.filter(
        (draft) =>
          draft.status === "submitted" || draft.status === "submitting",
      );
      for (const draft of drafts) {
        if (draft.status !== "submitted" && draft.status !== "submitting")
          revokeObjectUrl(draft.previewUrl);
      }
      setDrafts(kept);
      setActiveDraftId(kept[0]?.id ?? null);
      setFormError(null);
      setBatchMessage(null);
      setConfirmationAction(null);
    }
  };

  const handleSubmitReady = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSubmitting || isCompressing || isLoadingAssignedCreatives) return;
    setFormError(null);
    setBatchMessage(null);

    if (assignedCreativesError) {
      setFormError(
        "Reload your saved creatives before submitting, so existing Brick assignments can be checked.",
      );
      return;
    }

    const readyDrafts = drafts.filter(
      (draft) =>
        draft.status !== "submitted" &&
        draft.status !== "submitting" &&
        draftIssues.get(draft.id) === null,
    );

    if (readyDrafts.length === 0) {
      setFormError(
        "Nothing is ready to submit yet. Add an image, place it, complete its details, and resolve any overlaps.",
      );
      return;
    }

    setIsSubmitting(true);
    let succeeded = 0;
    let failed = 0;

    try {
      for (const draft of readyDrafts) {
        patchDraft(draft.id, { status: "submitting", error: null });
        try {
          if (!draft.region) throw new Error("This creative has no placement.");

          let storagePath = draft.storagePath;
          if (!storagePath) {
            if (!draft.file) throw new Error("This creative has no image.");
            storagePath = await api.uploadPrivateCreative(draft.file);
            patchDraft(draft.id, { storagePath });
          }

          const brickIds = getBricksInsideRegion(brickRows, draft.region);
          if (!areBricksConnected(brickIds))
            throw new Error(
              "The selected Bricks must form one connected region.",
            );

          const metadata: CreativeSubmissionMetadata = {
            category: draft.category.trim(),
            intendedAudience: draft.intendedAudience.trim(),
            destinationUrl: new URL(draft.destinationUrl.trim()).toString(),
          };

          const creativeId = await api.submitCreativeToBricks(
            brickIds.sort((a, b) => a - b),
            storagePath,
            metadata,
          );

          patchDraft(draft.id, {
            status: "submitted",
            creativeId,
            storagePath,
            error: null,
            assignedBrickIds: brickIds,
            reviewStatus: "pending",
          });
          succeeded += 1;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Submission failed.";
          patchDraft(draft.id, { status: "error", error: message });
          failed += 1;
        }
      }

      setBatchMessage(
        [
          `${succeeded} creative${succeeded === 1 ? "" : "s"} submitted for review.`,
          failed > 0
            ? `${failed} submission${failed === 1 ? "" : "s"} failed. Failed drafts are still here to retry.`
            : null,
        ]
          .filter(Boolean)
          .join(" "),
      );

      if (succeeded > 0) onSubmitted();
    } finally {
      setIsSubmitting(false);
    }
  };

  const clipIds = useMemo(() => {
    const result = new Map<string, string>();
    for (const draft of drafts) {
      result.set(
        draft.id,
        `creative-clip-${componentId}-${draft.id.replace(/[^a-zA-Z0-9_-]/g, "")}`,
      );
    }
    return result;
  }, [drafts, componentId]);

  const activeIds = activeDraft ? (idsByDraft.get(activeDraft.id) ?? []) : [];
  const activeIssue = activeDraft
    ? (draftIssues.get(activeDraft.id) ?? null)
    : null;
  const canvasDrafts = [
    ...drafts.filter((draft) => draft.id !== activeDraftId),
    ...drafts.filter((draft) => draft.id === activeDraftId),
  ];

  const statusForDraft = (draft: CreativeDraft) => {
    const issue = draftIssues.get(draft.id);
    if (draft.status === "submitted") {
      if (draft.reviewStatus === "approved")
        return { text: "Live on The Wall", tone: "positive" as const };
      if (draft.reviewStatus === "rejected")
        return { text: "Not approved", tone: "danger" as const };
      return { text: "Awaiting review", tone: "warning" as const };
    }
    if (draft.status === "submitting")
      return { text: "Submitting", tone: "neutral" as const };
    if (draft.status === "error")
      return { text: "Retry needed", tone: "danger" as const };
    if (!draft.region) return { text: "Place image", tone: "neutral" as const };
    if (issue) return { text: "Needs attention", tone: "warning" as const };
    return { text: "Ready", tone: "positive" as const };
  };

  return (
    <section className="mb-10 overflow-hidden rounded-2xl border border-white/10 bg-[#0a0a0a] shadow-[0_28px_100px_rgba(0,0,0,0.35)]">
      <header className="flex flex-col justify-between gap-5 border-b border-white/[0.08] bg-[radial-gradient(ellipse_at_top_left,rgba(255,255,255,0.055),transparent_55%)] px-5 py-6 sm:px-7 lg:flex-row lg:items-center">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-[10px] font-medium tracking-[0.2em] text-neutral-500">
            <span>WALCAY</span>
            <span className="text-neutral-700">/</span>
            <span>TERRITORY</span>
            <span className="text-neutral-700">/</span>
            <span>PLOT {plot.plotKey}</span>
          </div>
          <h2 className="mt-3 text-2xl font-medium tracking-[-0.04em] text-white sm:text-3xl">
            Creative Studio<span className="text-neutral-600">.</span>
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-neutral-400">
            Place each idea precisely. Every image can occupy its own connected
            region, with its own audience and destination.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="hidden rounded-xl border border-white/[0.08] bg-black/30 px-4 py-3 sm:block">
            <p className="text-[10px] uppercase tracking-[0.16em] text-neutral-500">
              Your Plot
            </p>
            <p className="mt-1 text-sm font-medium text-neutral-100">
              {plot.brickCount.toLocaleString()}{" "}
              <span className="font-normal text-neutral-500">Bricks</span>
            </p>
          </div>
          <button
            type="button"
            onClick={requestClose}
            disabled={
              isSubmitting || isCompressing || isLoadingAssignedCreatives
            }
            className="inline-flex items-center gap-2 rounded-xl border border-white/10 px-4 py-2.5 text-sm text-neutral-300 transition hover:border-white/20 hover:bg-white/[0.04] hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            <span aria-hidden="true">×</span> Close studio
          </button>
        </div>
      </header>

      {isLoadingAssignedCreatives && (
        <output
          aria-live="polite"
          className="flex items-center gap-3 border-b border-white/[0.07] bg-white/[0.02] px-5 py-3 text-xs text-neutral-400 sm:px-7"
        >
          <span
            aria-hidden="true"
            className="h-3.5 w-3.5 animate-spin rounded-full border border-white/15 border-t-white/70"
          />
          Restoring your saved creatives and placements…
        </output>
      )}

      {assignedCreativesError && !isLoadingAssignedCreatives && (
        <div
          role="alert"
          className="flex flex-col gap-3 border-b border-white/[0.08] bg-white/[0.025] px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-7"
        >
          <div>
            <p className="text-xs font-medium text-neutral-200">
              Saved creatives could not be restored.
            </p>
            <p className="mt-1 text-xs leading-relaxed text-neutral-500">
              {assignedCreativesError} Your existing submission has not been
              changed.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadAssignedCreatives()}
            disabled={
              isSubmitting || isCompressing || isLoadingAssignedCreatives
            }
            className="inline-flex shrink-0 items-center justify-center rounded-lg border border-white/10 px-3 py-2 text-xs text-neutral-200 transition hover:bg-white/[0.05] disabled:opacity-40"
          >
            Retry loading
          </button>
        </div>
      )}

      {!isLoadingAssignedCreatives &&
        !assignedCreativesError &&
        drafts.some(
          (draft) => draft.status === "submitted" && !draft.previewUrl,
        ) && (
          <output
            aria-live="polite"
            className="block border-b border-white/[0.07] px-5 py-3 text-xs text-neutral-500 sm:px-7"
          >
            Your saved creative details are restored, but one or more image
            previews could not be loaded. Retry reopening this Plot to refresh
            the preview link.
          </output>
        )}

      <form onSubmit={handleSubmitReady} noValidate>
        <div className="grid grid-cols-1 items-stretch xl:grid-cols-[minmax(0,1fr)_390px]">
          {/* Main canvas */}
          <section className="min-w-0 border-b border-white/[0.08] p-4 sm:p-6 xl:col-start-1 xl:row-start-1 xl:border-b-0 xl:border-r">
            <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-neutral-200" />
                  <h3 className="text-sm font-medium text-white">
                    Placement canvas
                  </h3>
                </div>
                <p className="mt-1.5 text-xs text-neutral-500">
                  {plot.width} × {plot.height} grid{" "}
                  <span className="mx-1.5 text-neutral-700">/</span>{" "}
                  {activeDraft
                    ? `${activeIds.length.toLocaleString()} Bricks selected`
                    : "Select an image to begin"}
                </p>
              </div>

              <div className="flex items-center rounded-xl border border-white/[0.09] bg-black/40 p-1">
                <button
                  type="button"
                  onClick={() => handleZoom(-1)}
                  disabled={
                    zoomIndex === 0 ||
                    isSubmitting ||
                    isCompressing ||
                    isLoadingAssignedCreatives
                  }
                  aria-label="Zoom out"
                  className="grid h-8 w-8 place-items-center rounded-lg text-lg text-neutral-300 transition hover:bg-white/[0.07] disabled:opacity-25"
                >
                  −
                </button>
                <span className="min-w-11 text-center text-xs tabular-nums text-neutral-400">
                  {zoom}×
                </span>
                <button
                  type="button"
                  onClick={() => handleZoom(1)}
                  disabled={
                    zoomIndex === ZOOM_LEVELS.length - 1 ||
                    isSubmitting ||
                    isCompressing ||
                    isLoadingAssignedCreatives
                  }
                  aria-label="Zoom in"
                  className="grid h-8 w-8 place-items-center rounded-lg text-lg text-neutral-300 transition hover:bg-white/[0.07] disabled:opacity-25"
                >
                  +
                </button>
                <span className="mx-1.5 h-4 w-px bg-white/10" />
                <button
                  type="button"
                  onClick={handleFitPlot}
                  disabled={
                    isSubmitting || isCompressing || isLoadingAssignedCreatives
                  }
                  className="rounded-lg px-2.5 py-2 text-[11px] text-neutral-400 transition hover:bg-white/[0.07] hover:text-white disabled:opacity-40"
                >
                  Fit
                </button>
              </div>
            </div>

            <div className="mb-3 flex flex-wrap items-center gap-1.5">
              {(
                [
                  ["select", "Select"],
                  ["move", "Move"],
                  ["resize", "Resize"],
                  ["pan", "Pan"],
                ] as const
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={placementMode === mode}
                  disabled={
                    isSubmitting ||
                    isCompressing ||
                    isLoadingAssignedCreatives ||
                    (mode !== "pan" && !editableActive)
                  }
                  onClick={() => {
                    dragRef.current = null;
                    setPlacementMode(mode);
                  }}
                  className={`rounded-lg border px-3 py-2 text-xs transition ${placementMode === mode ? "border-white/25 bg-white/[0.1] text-white shadow-inner" : "border-white/[0.07] text-neutral-400 hover:border-white/15 hover:bg-white/[0.035] hover:text-neutral-200"} disabled:cursor-not-allowed disabled:opacity-35`}
                >
                  {label}
                </button>
              ))}
              <span className="hidden flex-1 sm:block" />
              <button
                type="button"
                disabled={
                  !editableActive ||
                  isSubmitting ||
                  isCompressing ||
                  isLoadingAssignedCreatives
                }
                onClick={handleSelectEntirePlot}
                className="rounded-lg border border-white/[0.07] px-3 py-2 text-xs text-neutral-400 transition hover:border-white/15 hover:bg-white/[0.035] hover:text-white disabled:opacity-35"
              >
                Entire Plot
              </button>
              <button
                type="button"
                disabled={
                  !editableActive ||
                  !activeDraft?.region ||
                  isSubmitting ||
                  isCompressing ||
                  isLoadingAssignedCreatives
                }
                onClick={handleClearRegion}
                className="rounded-lg border border-white/[0.07] px-3 py-2 text-xs text-neutral-400 transition hover:border-white/15 hover:bg-white/[0.035] hover:text-white disabled:opacity-35"
              >
                Clear
              </button>
            </div>

            <div className="relative h-[340px] overflow-hidden rounded-xl border border-white/[0.09] bg-[#050505] sm:h-[440px] lg:h-[500px]">
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 opacity-[0.1]"
                style={{
                  backgroundImage:
                    "radial-gradient(#737373 0.7px, transparent 0.7px)",
                  backgroundSize: "18px 18px",
                }}
              />
              {!activeDraft && (
                <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-6">
                  <div className="max-w-xs text-center">
                    <div className="mx-auto mb-4 grid h-11 w-11 place-items-center rounded-2xl border border-white/10 bg-white/[0.035] text-xl text-neutral-500">
                      ＋
                    </div>
                    <p className="text-sm font-medium text-neutral-300">
                      Start with an image
                    </p>
                    <p className="mt-2 text-xs leading-relaxed text-neutral-600">
                      Add one or several images in the library, then draw a
                      region for each one.
                    </p>
                  </div>
                </div>
              )}

              <svg
                ref={svgRef}
                role="img"
                aria-label={`Interactive placement canvas for Plot ${plot.plotKey}`}
                viewBox={viewBox}
                className={`relative h-full w-full touch-none select-none ${placementMode === "pan" ? "cursor-grab active:cursor-grabbing" : placementMode === "move" ? "cursor-move" : "cursor-crosshair"}`}
                preserveAspectRatio="xMidYMid meet"
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={finishPointerAction}
                onPointerCancel={finishPointerAction}
                onLostPointerCapture={() => {
                  dragRef.current = null;
                }}
              >
                <title>{`Creative placement on Plot ${plot.plotKey}`}</title>
                <defs>
                  {canvasDrafts.map((draft) => {
                    const clipId = clipIds.get(draft.id);
                    const ids = idsByDraft.get(draft.id) ?? [];
                    if (!draft.region || !clipId || ids.length === 0)
                      return null;
                    return (
                      <clipPath
                        key={clipId}
                        id={clipId}
                        clipPathUnits="userSpaceOnUse"
                      >
                        {ids.map((id) => (
                          <rect
                            key={id}
                            x={(id % 1000) - plot.minX}
                            y={Math.floor(id / 1000) - plot.minY}
                            width={1}
                            height={1}
                          />
                        ))}
                      </clipPath>
                    );
                  })}
                </defs>

                {plot.brickIds.map((id) => (
                  <rect
                    key={id}
                    x={(id % 1000) - plot.minX + 0.025}
                    y={Math.floor(id / 1000) - plot.minY + 0.025}
                    width={0.95}
                    height={0.95}
                    rx={0.035}
                    fill="#262626"
                    stroke="#090909"
                    strokeWidth={0.025}
                  />
                ))}

                {canvasDrafts.map((draft) => {
                  const region = draft.region;
                  const clipId = clipIds.get(draft.id);
                  const ids = idsByDraft.get(draft.id) ?? [];
                  const isActive = draft.id === activeDraftId;
                  if (!region) return null;

                  return (
                    <g key={draft.id}>
                      {draft.previewUrl && clipId && ids.length > 0 && (
                        <image
                          href={draft.previewUrl}
                          x={region.x}
                          y={region.y}
                          width={region.width}
                          height={region.height}
                          preserveAspectRatio="xMidYMid slice"
                          clipPath={`url(#${clipId})`}
                          pointerEvents="none"
                        />
                      )}
                      <rect
                        x={region.x + 0.025}
                        y={region.y + 0.025}
                        width={Math.max(region.width - 0.05, 0.1)}
                        height={Math.max(region.height - 0.05, 0.1)}
                        fill="none"
                        stroke={isActive ? "#ffffff" : "#8a8a8a"}
                        strokeWidth={isActive ? 0.065 : 0.035}
                        strokeDasharray={
                          draft.status === "submitted" ? "0.08 0.12" : undefined
                        }
                        pointerEvents="none"
                      />
                      {isActive &&
                        editableActive &&
                        placementMode === "resize" && (
                          <circle
                            data-resize-handle="true"
                            cx={region.x + region.width - 0.18}
                            cy={region.y + region.height - 0.18}
                            r={0.18}
                            fill="#ffffff"
                            stroke="#333333"
                            strokeWidth={0.07}
                            vectorEffect="non-scaling-stroke"
                            className="cursor-nwse-resize"
                          />
                        )}
                    </g>
                  );
                })}
              </svg>
            </div>

            <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
              <p className="max-w-xl text-xs leading-relaxed text-neutral-500">
                {placementMode === "select"
                  ? "Drag across the canvas to draw a region."
                  : placementMode === "move"
                    ? "Drag inside the selected region to move it."
                    : placementMode === "resize"
                      ? "Drag the white corner handle to resize the region."
                      : "Drag the canvas to move around your Plot."}
              </p>
              {activeDraft?.region && (
                <p
                  className={`text-xs tabular-nums ${activeIssue ? "text-neutral-300" : "text-neutral-500"}`}
                >
                  {activeIssue ??
                    `${activeIds.length.toLocaleString()} Bricks selected`}
                </p>
              )}
            </div>

            <div className="mt-5 grid grid-cols-3 divide-x divide-white/[0.08] rounded-xl border border-white/[0.08] bg-white/[0.02]">
              <div className="px-3 py-3.5 sm:px-4">
                <p className="text-[10px] uppercase tracking-[0.12em] text-neutral-600">
                  In Plot
                </p>
                <p className="mt-1.5 text-sm font-medium tabular-nums text-neutral-200">
                  {plot.brickCount.toLocaleString()}
                </p>
              </div>
              <div className="px-3 py-3.5 sm:px-4">
                <p className="text-[10px] uppercase tracking-[0.12em] text-neutral-600">
                  Selected
                </p>
                <p className="mt-1.5 text-sm font-medium tabular-nums text-neutral-200">
                  {activeIds.length.toLocaleString()}
                </p>
              </div>
              <div className="px-3 py-3.5 sm:px-4">
                <p className="text-[10px] uppercase tracking-[0.12em] text-neutral-600">
                  Ready
                </p>
                <p className="mt-1.5 text-sm font-medium tabular-nums text-neutral-200">
                  {readyCount.toLocaleString()}
                </p>
              </div>
            </div>
          </section>

          {/* Library and inspector: fixed visual column on wide screens, stacked on small screens. */}
          <aside className="min-w-0 xl:col-start-2 xl:row-start-1 xl:flex xl:h-[790px] xl:flex-col xl:overflow-hidden">
            <section className="min-w-0 border-b border-white/[0.08] p-4 sm:p-5 xl:flex xl:min-h-0 xl:flex-[0_0_47%] xl:flex-col">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-medium text-white">
                      Image library
                    </h3>
                    <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] tabular-nums text-neutral-500">
                      {drafts.length}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-neutral-600">
                    Each image gets its own placement.
                  </p>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
                  onChange={handleAddImages}
                  disabled={
                    isSubmitting || isCompressing || isLoadingAssignedCreatives
                  }
                  className="hidden"
                  aria-label="Choose images to add"
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={
                    isSubmitting || isCompressing || isLoadingAssignedCreatives
                  }
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-white px-3 py-2.5 text-xs font-semibold text-black transition hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <span aria-hidden="true" className="text-base leading-none">
                    ＋
                  </span>
                  {isCompressing ? "Adding…" : "Add images"}
                </button>
              </div>

              {compressionProgress && (
                <output
                  aria-live="polite"
                  className="mt-3 block rounded-lg border border-white/[0.08] bg-black/40 px-3 py-2 text-xs text-neutral-400"
                >
                  Preparing image{" "}
                  {Math.min(
                    compressionProgress.done + 1,
                    compressionProgress.total,
                  )}{" "}
                  of {compressionProgress.total}…
                </output>
              )}

              <label
                htmlFor={`creative-search-${componentId}`}
                className="sr-only"
              >
                Search image library
              </label>
              <input
                id={`creative-search-${componentId}`}
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search images or categories"
                disabled={isSubmitting}
                className="mt-4 w-full rounded-lg border border-white/[0.09] bg-black/35 px-3 py-2.5 text-xs text-white outline-none transition placeholder:text-neutral-600 focus:border-white/25 disabled:opacity-40"
              />

              <div className="mt-3 flex flex-wrap gap-1.5">
                {(
                  [
                    ["all", "All"],
                    ["placement", "Placement"],
                    ["attention", "Attention"],
                    ["submitted", "Submitted"],
                  ] as const
                ).map(([filter, label]) => (
                  <button
                    key={filter}
                    type="button"
                    aria-pressed={assetFilter === filter}
                    disabled={isSubmitting}
                    onClick={() => setAssetFilter(filter)}
                    className={`rounded-lg border px-2.5 py-1.5 text-[10px] transition disabled:opacity-40 ${assetFilter === filter ? "border-white/20 bg-white/[0.09] text-white" : "border-white/[0.07] text-neutral-500 hover:border-white/15 hover:text-neutral-300"}`}
                  >
                    {label}
                    <span className="ml-1.5 tabular-nums text-neutral-600">
                      {filterCounts[filter]}
                    </span>
                  </button>
                ))}
              </div>

              <div className="mt-3 min-h-[140px] overflow-y-auto overscroll-contain rounded-xl border border-white/[0.07] bg-black/25 p-2 xl:min-h-0 xl:flex-1">
                {visibleDrafts.length > 0 ? (
                  <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 xl:grid-cols-3 2xl:grid-cols-4">
                    {visibleDrafts.map((draft) => {
                      const isActive = draft.id === activeDraftId;
                      const status = statusForDraft(draft);
                      const position =
                        drafts.findIndex((item) => item.id === draft.id) + 1;
                      return (
                        <button
                          key={draft.id}
                          type="button"
                          aria-pressed={isActive}
                          disabled={isSubmitting}
                          onClick={() => {
                            setActiveDraftId(draft.id);
                            setFormError(null);
                          }}
                          className={`min-w-0 overflow-hidden rounded-lg border text-left transition disabled:cursor-not-allowed disabled:opacity-60 ${isActive ? "border-white/40 bg-white/[0.07] ring-1 ring-white/10" : "border-white/[0.04] bg-white/[0.015] hover:border-white/15 hover:bg-white/[0.04]"}`}
                          title={draft.originalName}
                        >
                          <div className="relative aspect-square overflow-hidden bg-[#111]">
                            {draft.previewUrl ? (
                              <img
                                src={draft.previewUrl}
                                alt=""
                                className="h-full w-full object-cover"
                                loading="lazy"
                              />
                            ) : (
                              <div className="flex h-full items-center justify-center text-[10px] text-neutral-600">
                                No preview
                              </div>
                            )}
                            <span className="absolute left-1.5 top-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[9px] tabular-nums text-neutral-200">
                              {position.toString().padStart(2, "0")}
                            </span>
                            {isActive && (
                              <span
                                aria-hidden="true"
                                className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-white shadow-[0_0_8px_rgba(255,255,255,0.65)]"
                              />
                            )}
                          </div>
                          <div className="px-2 py-2">
                            <p className="truncate text-[10px] text-neutral-300">
                              {draft.originalName}
                            </p>
                            <p className="mt-1 truncate text-[9px] text-neutral-600">
                              {status.text}
                            </p>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="flex min-h-[120px] flex-col items-center justify-center px-4 py-7 text-center">
                    <p className="text-xs font-medium text-neutral-400">
                      {drafts.length === 0
                        ? "Your library is empty"
                        : "No matching images"}
                    </p>
                    <p className="mt-1.5 max-w-[220px] text-[11px] leading-relaxed text-neutral-600">
                      {drafts.length === 0
                        ? "Add a batch of images to build your creative collection."
                        : "Try another search or filter."}
                    </p>
                    {drafts.length === 0 && (
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={
                          isSubmitting ||
                          isCompressing ||
                          isLoadingAssignedCreatives
                        }
                        className="mt-4 text-xs text-neutral-300 underline underline-offset-4 hover:text-white disabled:opacity-40"
                      >
                        Choose images
                      </button>
                    )}
                  </div>
                )}
              </div>

              <div className="mt-3 flex items-center justify-between gap-3">
                <p className="text-[10px] leading-relaxed text-neutral-600">
                  JPEG · PNG · WebP
                </p>
                <button
                  type="button"
                  onClick={requestClearDrafts}
                  disabled={
                    isSubmitting ||
                    isCompressing ||
                    isLoadingAssignedCreatives ||
                    !drafts.some(
                      (draft) =>
                        draft.status !== "submitted" &&
                        draft.status !== "submitting",
                    )
                  }
                  className="text-[10px] text-neutral-600 underline decoration-neutral-800 underline-offset-4 transition hover:text-neutral-300 disabled:cursor-not-allowed disabled:opacity-30"
                >
                  Clear unfinished
                </button>
              </div>
            </section>

            <section className="min-w-0 p-4 sm:p-5 xl:min-h-0 xl:flex-1 xl:overflow-y-auto">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[9px] font-medium uppercase tracking-[0.2em] text-neutral-600">
                    Creative details
                  </p>
                  <h3 className="mt-1.5 truncate text-sm font-medium text-white">
                    {activeDraft?.originalName ?? "No image selected"}
                  </h3>
                </div>
                {activeDraft && (
                  <StatusPill tone={statusForDraft(activeDraft).tone}>
                    {statusForDraft(activeDraft).text}
                  </StatusPill>
                )}
              </div>

              {!activeDraft ? (
                <div className="mt-5 rounded-xl border border-dashed border-white/10 px-4 py-8 text-center">
                  <p className="text-xs text-neutral-400">
                    Select an image to edit it.
                  </p>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-neutral-600">
                    Placement, category, audience and destination live here.
                  </p>
                </div>
              ) : activeDraft.status === "submitted" ? (
                <div className="mt-5 rounded-xl border border-white/[0.08] bg-white/[0.025] p-4">
                  <div className="flex items-center gap-2 text-sm text-neutral-200">
                    <span className="grid h-6 w-6 place-items-center rounded-full border border-white/15 text-xs">
                      {activeDraft.reviewStatus === "approved"
                        ? "✓"
                        : activeDraft.reviewStatus === "rejected"
                          ? "—"
                          : "…"}
                    </span>
                    {activeDraft.reviewStatus === "approved"
                      ? "Live on The Wall"
                      : activeDraft.reviewStatus === "rejected"
                        ? "Not approved"
                        : "Awaiting moderation"}
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-neutral-500">
                    {activeDraft.reviewStatus === "approved"
                      ? "This approved image is currently assigned to the Bricks shown on the canvas."
                      : activeDraft.reviewStatus === "rejected"
                        ? "This creative was not approved and is not currently active on the Wall."
                        : "Your image and exact Brick placement are saved. The current live artwork, if any, remains unchanged until moderation is complete."}
                  </p>
                  {activeDraft.creativeId && (
                    <p className="mt-3 break-all font-mono text-[10px] text-neutral-600">
                      ID · {activeDraft.creativeId}
                    </p>
                  )}
                  <div className="mt-4 grid grid-cols-2 gap-2">
                    <div className="rounded-lg bg-black/30 p-3">
                      <p className="text-[9px] uppercase tracking-wide text-neutral-600">
                        Category
                      </p>
                      <p className="mt-1 truncate text-xs text-neutral-300">
                        {activeDraft.category || "—"}
                      </p>
                    </div>
                    <div className="rounded-lg bg-black/30 p-3">
                      <p className="text-[9px] uppercase tracking-wide text-neutral-600">
                        Bricks
                      </p>
                      <p className="mt-1 text-xs tabular-nums text-neutral-300">
                        {activeIds.length.toLocaleString()}
                      </p>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="mt-4 space-y-4">
                  {activeDraft.file && (
                    <>
                      <input
                        ref={replaceInputRef}
                        type="file"
                        accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
                        onChange={handleReplaceImage}
                        disabled={
                          isSubmitting ||
                          isCompressing ||
                          isLoadingAssignedCreatives
                        }
                        className="hidden"
                        aria-label="Replace selected image"
                      />
                      <div className="flex items-center justify-between gap-3 rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2.5">
                        <div className="flex min-w-0 items-center gap-2.5">
                          {activeDraft.previewUrl && (
                            <img
                              src={activeDraft.previewUrl}
                              alt=""
                              className="h-9 w-9 shrink-0 rounded-md object-cover"
                            />
                          )}
                          <div className="min-w-0">
                            <p className="text-[11px] text-neutral-300">
                              Image attached
                            </p>
                            <p className="mt-0.5 truncate text-[10px] text-neutral-600">
                              {activeDraft.originalName}
                            </p>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => replaceInputRef.current?.click()}
                          disabled={
                            isSubmitting ||
                            isCompressing ||
                            isLoadingAssignedCreatives
                          }
                          className="shrink-0 text-[10px] text-neutral-300 underline underline-offset-4 transition hover:text-white disabled:opacity-40"
                        >
                          Replace
                        </button>
                      </div>
                    </>
                  )}

                  <label className="block">
                    <span className="mb-1.5 flex items-center justify-between gap-3 text-[11px] text-neutral-400">
                      <span>Category</span>
                      <span className="text-[10px] text-neutral-600">
                        Required
                      </span>
                    </span>
                    <input
                      type="text"
                      minLength={2}
                      maxLength={60}
                      value={activeDraft.category}
                      onChange={(event) =>
                        patchEditableDraft(activeDraft.id, {
                          category: event.target.value,
                        })
                      }
                      disabled={
                        isSubmitting ||
                        isCompressing ||
                        isLoadingAssignedCreatives
                      }
                      placeholder="Art, fashion, music…"
                      className="w-full rounded-lg border border-white/[0.09] bg-black/35 px-3 py-2.5 text-xs text-white outline-none transition placeholder:text-neutral-700 focus:border-white/25 disabled:opacity-50"
                    />
                  </label>

                  <label className="block">
                    <span className="mb-1.5 flex items-center justify-between gap-3 text-[11px] text-neutral-400">
                      <span>Intended audience</span>
                      <span className="text-[10px] text-neutral-600">
                        {activeDraft.intendedAudience.length}/300
                      </span>
                    </span>
                    <textarea
                      minLength={2}
                      maxLength={300}
                      rows={3}
                      value={activeDraft.intendedAudience}
                      onChange={(event) =>
                        patchEditableDraft(activeDraft.id, {
                          intendedAudience: event.target.value,
                        })
                      }
                      disabled={
                        isSubmitting ||
                        isCompressing ||
                        isLoadingAssignedCreatives
                      }
                      placeholder="Who should this creative reach?"
                      className="w-full resize-y rounded-lg border border-white/[0.09] bg-black/35 px-3 py-2.5 text-xs leading-relaxed text-white outline-none transition placeholder:text-neutral-700 focus:border-white/25 disabled:opacity-50"
                    />
                  </label>

                  <label className="block">
                    <span className="mb-1.5 flex items-center justify-between gap-3 text-[11px] text-neutral-400">
                      <span>Destination URL</span>
                      <span className="text-[10px] text-neutral-600">
                        HTTPS
                      </span>
                    </span>
                    <input
                      type="url"
                      maxLength={2048}
                      value={activeDraft.destinationUrl}
                      onChange={(event) =>
                        patchEditableDraft(activeDraft.id, {
                          destinationUrl: event.target.value,
                        })
                      }
                      disabled={
                        isSubmitting ||
                        isCompressing ||
                        isLoadingAssignedCreatives
                      }
                      placeholder="https://yourwebsite.com"
                      className="w-full rounded-lg border border-white/[0.09] bg-black/35 px-3 py-2.5 text-xs text-white outline-none transition placeholder:text-neutral-700 focus:border-white/25 disabled:opacity-50"
                    />
                  </label>

                  <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-3.5">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-[11px] text-neutral-400">Placement</p>
                      <p className="text-xs tabular-nums text-neutral-200">
                        {activeIds.length.toLocaleString()}{" "}
                        <span className="text-neutral-600">Bricks</span>
                      </p>
                    </div>
                    <p className="mt-1.5 text-[10px] leading-relaxed text-neutral-600">
                      One connected region. Each Brick can belong to only one
                      unfinished creative at a time.
                    </p>
                    {activeIssue && (
                      <p
                        role="alert"
                        className="mt-3 border-t border-white/[0.07] pt-3 text-[11px] leading-relaxed text-neutral-300"
                      >
                        {activeDraft.status === "error" && activeDraft.error
                          ? activeDraft.error
                          : activeIssue}
                      </p>
                    )}
                    {activeDraft.status === "error" &&
                      !activeIssue &&
                      activeDraft.error && (
                        <p
                          role="alert"
                          className="mt-3 border-t border-white/[0.07] pt-3 text-[11px] leading-relaxed text-neutral-300"
                        >
                          Last attempt failed: {activeDraft.error} You can retry
                          without uploading the image again.
                        </p>
                      )}
                    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
                      <button
                        type="button"
                        disabled={
                          !activeDraft.region ||
                          isSubmitting ||
                          isCompressing ||
                          isLoadingAssignedCreatives
                        }
                        onClick={handleClearRegion}
                        className="text-[10px] text-neutral-500 underline underline-offset-4 transition hover:text-white disabled:opacity-30"
                      >
                        Clear placement
                      </button>
                      <button
                        type="button"
                        disabled={
                          isSubmitting ||
                          isCompressing ||
                          isLoadingAssignedCreatives ||
                          activeDraft.status === "submitting"
                        }
                        onClick={() => handleRemoveDraft(activeDraft)}
                        className="text-[10px] text-neutral-500 underline underline-offset-4 transition hover:text-white disabled:opacity-30"
                      >
                        Remove image
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </section>
          </aside>
        </div>

        <footer className="border-t border-white/[0.08] bg-white/[0.02] px-5 py-4 sm:px-7">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
              <div>
                <p className="text-sm font-medium text-white">
                  {readyCount} ready to submit
                </p>
                <p className="mt-1 text-[11px] text-neutral-600">
                  {submittedCount} saved{" "}
                  <span className="mx-1 text-neutral-800">·</span> {unsentCount}{" "}
                  unfinished
                </p>
              </div>
              <div className="hidden h-8 w-px bg-white/[0.08] sm:block" />
              <p className="max-w-md text-[11px] leading-relaxed text-neutral-600">
                New work is reviewed before it appears. Existing approved
                artwork stays live during review.
              </p>
            </div>
            <button
              type="submit"
              disabled={
                isSubmitting ||
                isCompressing ||
                isLoadingAssignedCreatives ||
                readyCount === 0
              }
              className="inline-flex items-center justify-center gap-3 rounded-xl bg-white px-5 py-3 text-sm font-semibold text-black transition hover:bg-neutral-200 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-400"
            >
              {isSubmitting
                ? "Submitting creatives…"
                : `Submit ${readyCount} creative${readyCount === 1 ? "" : "s"}`}
              <span aria-hidden="true" className="text-base">
                ↗
              </span>
            </button>
          </div>
          {formError && (
            <div
              role="alert"
              className="mt-4 rounded-xl border border-white/[0.12] bg-white/[0.035] px-4 py-3 text-xs leading-relaxed text-neutral-300"
            >
              {formError}
            </div>
          )}
          {batchMessage && (
            <output
              aria-live="polite"
              className="mt-4 block rounded-xl border border-white/[0.08] bg-white/[0.025] px-4 py-3 text-xs leading-relaxed text-neutral-300"
            >
              {batchMessage}
            </output>
          )}
        </footer>
      </form>

      {confirmationAction && (
        <dialog
          open
          aria-modal="true"
          aria-labelledby={`confirm-title-${componentId}`}
          className="fixed inset-0 z-[100] m-0 flex h-full w-full max-w-none items-center justify-center border-0 bg-black/75 p-4 text-white backdrop:bg-black/75"
        >
          <section className="w-full max-w-md rounded-2xl border border-white/15 bg-[#111] p-6 shadow-[0_30px_120px_rgba(0,0,0,0.8)]">
            <p className="text-[10px] uppercase tracking-[0.2em] text-neutral-600">
              Walcay / Creative Studio
            </p>
            <h3
              id={`confirm-title-${componentId}`}
              className="mt-3 text-lg font-medium tracking-tight text-white"
            >
              {confirmationAction === "close"
                ? "Close this studio?"
                : "Clear unfinished drafts?"}
            </h3>
            <p className="mt-3 text-sm leading-relaxed text-neutral-400">
              {confirmationAction === "close"
                ? `You have ${unsentCount} unfinished creative draft${unsentCount === 1 ? "" : "s"}. Closing discards their unsaved placements and details. Submitted creatives and their saved placements remain on your account.`
                : "Unfinished images, placements and details will be removed from this workspace. Previously submitted creatives will remain here."}
            </p>
            <div className="mt-7 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => setConfirmationAction(null)}
                className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-neutral-300 transition hover:bg-white/[0.04] hover:text-white"
              >
                Keep working
              </button>
              <button
                type="button"
                onClick={confirmDialogAction}
                className="rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-black transition hover:bg-neutral-200"
              >
                {confirmationAction === "close"
                  ? "Discard and close"
                  : "Clear unfinished"}
              </button>
            </div>
          </section>
        </dialog>
      )}
    </section>
  );
}

export default function Manage() {
  const [plots, setPlots] = useState<ManagedPlot[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeWorkspacePlot, setActiveWorkspacePlot] =
    useState<ManagedPlot | null>(null);
  const requestSequenceRef = useRef(0);

  const loadPlots = useCallback(async () => {
    const requestId = ++requestSequenceRef.current;
    setIsLoading(true);
    setError(null);

    try {
      const data = await api.getMyPlots();
      if (requestId !== requestSequenceRef.current) return;
      setPlots(data);
      setActiveWorkspacePlot((current) => {
        if (!current) return null;
        return data.find((plot) => plot.plotKey === current.plotKey) ?? null;
      });
    } catch (err) {
      if (requestId !== requestSequenceRef.current) return;
      setError(
        err instanceof Error ? err.message : "Unable to load your territory.",
      );
    } finally {
      if (requestId === requestSequenceRef.current) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPlots();
    return () => {
      requestSequenceRef.current += 1;
    };
  }, [loadPlots]);

  const totalBricks = plots.reduce((sum, plot) => sum + plot.brickCount, 0);
  const activeCreativePlots = plots.filter(
    (plot) => plot.hasActiveCreative,
  ).length;
  const pendingCreativePlots = plots.filter(
    (plot) => plot.hasPendingCreative,
  ).length;

  return (
    <main className="min-h-screen bg-[#080808] px-4 py-6 text-white sm:px-6 sm:py-9 lg:px-10">
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-x-0 top-0 h-[440px] bg-[radial-gradient(ellipse_at_top,rgba(255,255,255,0.045),transparent_66%)]"
      />
      <div className="relative mx-auto max-w-[1600px]">
        <header className="mb-8 border-b border-white/[0.08] pb-7 sm:mb-10 sm:flex sm:items-end sm:justify-between sm:gap-8">
          <div>
            <Link
              to="/"
              className="inline-flex items-center gap-2 text-[10px] font-semibold tracking-[0.24em] text-neutral-500 transition hover:text-white"
            >
              <span className="grid h-5 w-5 place-items-center rounded-md border border-white/15 text-[9px] text-neutral-300">
                W
              </span>{" "}
              WALCAY
            </Link>
            <p className="mt-6 text-[10px] uppercase tracking-[0.2em] text-neutral-600">
              Your territory
            </p>
            <h1 className="mt-2 text-3xl font-medium tracking-[-0.055em] text-white sm:text-4xl lg:text-5xl">
              Make room for ideas<span className="text-neutral-600">.</span>
            </h1>
            <p className="mt-3 max-w-xl text-sm leading-relaxed text-neutral-500">
              One Plot, many possibilities. Organize your Bricks and shape the
              creative that belongs on them.
            </p>
          </div>
          <Link
            to="/"
            className="mt-5 inline-flex shrink-0 items-center gap-2 self-start rounded-xl border border-white/10 px-4 py-3 text-xs text-neutral-300 transition hover:border-white/20 hover:bg-white/[0.035] hover:text-white sm:mt-0 sm:self-auto"
          >
            ← <span>Explore The Wall</span>
          </Link>
        </header>

        <section
          aria-label="Territory overview"
          className="mb-8 grid grid-cols-2 gap-3 lg:grid-cols-4"
        >
          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.025] p-4 sm:p-5">
            <p className="text-[10px] uppercase tracking-[0.16em] text-neutral-600">
              Total Bricks
            </p>
            <p className="mt-3 text-2xl font-medium tracking-tight tabular-nums text-white">
              {isLoading && plots.length === 0
                ? "—"
                : totalBricks.toLocaleString()}
            </p>
            <p className="mt-1 text-[11px] text-neutral-600">
              Across your territory
            </p>
          </div>
          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.025] p-4 sm:p-5">
            <p className="text-[10px] uppercase tracking-[0.16em] text-neutral-600">
              Connected Plots
            </p>
            <p className="mt-3 text-2xl font-medium tracking-tight tabular-nums text-white">
              {isLoading && plots.length === 0
                ? "—"
                : plots.length.toLocaleString()}
            </p>
            <p className="mt-1 text-[11px] text-neutral-600">
              Independently managed
            </p>
          </div>
          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.025] p-4 sm:p-5">
            <p className="text-[10px] uppercase tracking-[0.16em] text-neutral-600">
              Live Plots
            </p>
            <p className="mt-3 text-2xl font-medium tracking-tight tabular-nums text-white">
              {isLoading && plots.length === 0
                ? "—"
                : activeCreativePlots.toLocaleString()}
            </p>
            <p className="mt-1 text-[11px] text-neutral-600">
              Plots with approved artwork
            </p>
          </div>
          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.025] p-4 sm:p-5">
            <p className="text-[10px] uppercase tracking-[0.16em] text-neutral-600">
              Under review
            </p>
            <p className="mt-3 text-2xl font-medium tracking-tight tabular-nums text-white">
              {isLoading && plots.length === 0
                ? "—"
                : pendingCreativePlots.toLocaleString()}
            </p>
            <p className="mt-1 text-[11px] text-neutral-600">
              Plots with pending work
            </p>
          </div>
        </section>

        {error && (
          <div
            role="alert"
            className="mb-8 flex flex-col gap-4 rounded-2xl border border-white/10 bg-white/[0.025] p-4 sm:flex-row sm:items-center sm:justify-between sm:px-5"
          >
            <div>
              <p className="text-sm font-medium text-neutral-200">
                Your territory couldn’t be loaded.
              </p>
              <p className="mt-1 text-xs leading-relaxed text-neutral-500">
                {error}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void loadPlots()}
              disabled={isLoading}
              className="shrink-0 rounded-lg border border-white/10 px-4 py-2.5 text-xs text-neutral-200 transition hover:bg-white/[0.05] disabled:opacity-40"
            >
              {isLoading ? "Retrying…" : "Try again"}
            </button>
          </div>
        )}

        {activeWorkspacePlot && (
          <CreativeWorkspace
            key={activeWorkspacePlot.plotKey}
            plot={activeWorkspacePlot}
            onClose={() => setActiveWorkspacePlot(null)}
            onSubmitted={() => {
              void loadPlots();
            }}
          />
        )}

        {isLoading && plots.length === 0 && !error && (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2].map((item) => (
              <div
                key={item}
                className="animate-pulse overflow-hidden rounded-2xl border border-white/[0.07] bg-white/[0.02]"
              >
                <div className="h-44 bg-white/[0.025]" />
                <div className="space-y-3 p-5">
                  <div className="h-4 w-2/5 rounded bg-white/[0.05]" />
                  <div className="h-3 w-3/5 rounded bg-white/[0.04]" />
                  <div className="h-10 rounded-lg bg-white/[0.04]" />
                </div>
              </div>
            ))}
          </div>
        )}

        {plots.length > 0 && (
          <section>
            <div className="mb-4 flex items-end justify-between gap-4">
              <div>
                <p className="text-[10px] uppercase tracking-[0.2em] text-neutral-600">
                  Overview
                </p>
                <h2 className="mt-1.5 text-lg font-medium tracking-tight text-white">
                  Your Plots
                </h2>
              </div>
              {isLoading && (
                <output
                  aria-live="polite"
                  className="text-[11px] text-neutral-600"
                >
                  Refreshing territory…
                </output>
              )}
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {plots.map((plot) => {
                const isOpen = activeWorkspacePlot?.plotKey === plot.plotKey;
                const anotherOpen = activeWorkspacePlot !== null && !isOpen;
                let statusLabel = "Ready for a creative";
                let statusTone: "neutral" | "positive" | "warning" = "neutral";
                if (plot.hasActiveCreative && plot.hasPendingCreative) {
                  statusLabel = "Live · replacement in review";
                  statusTone = "warning";
                } else if (plot.hasPendingCreative) {
                  statusLabel = "Awaiting review";
                  statusTone = "warning";
                } else if (plot.hasActiveCreative) {
                  statusLabel = "Live creative";
                  statusTone = "positive";
                }

                return (
                  <article
                    key={plot.plotKey}
                    className={`group flex min-w-0 flex-col overflow-hidden rounded-2xl border bg-[#0a0a0a] transition duration-200 ${isOpen ? "border-white/25 shadow-[0_0_0_1px_rgba(255,255,255,0.04)]" : "border-white/[0.08] hover:border-white/[0.17] hover:bg-[#0c0c0c]"}`}
                  >
                    <div className="relative flex h-44 items-center justify-center overflow-hidden border-b border-white/[0.06] bg-[#060606] p-7">
                      <div
                        aria-hidden="true"
                        className="absolute inset-0 opacity-[0.08]"
                        style={{
                          backgroundImage:
                            "linear-gradient(to right, #888 1px, transparent 1px), linear-gradient(to bottom, #888 1px, transparent 1px)",
                          backgroundSize: "18px 18px",
                        }}
                      />
                      <div className="relative h-full w-full transition-transform duration-300 group-hover:scale-[1.025]">
                        <PlotPreview plot={plot} />
                      </div>
                      <span className="absolute left-4 top-4 rounded-md border border-white/[0.09] bg-black/60 px-2 py-1 text-[9px] uppercase tracking-[0.16em] text-neutral-500">
                        Plot {plot.plotKey}
                      </span>
                      {isOpen && (
                        <span className="absolute right-4 top-4">
                          <StatusPill tone="positive">Studio open</StatusPill>
                        </span>
                      )}
                    </div>

                    <div className="flex flex-1 flex-col p-5">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <h3 className="text-lg font-medium tracking-tight text-white">
                            {plot.brickCount.toLocaleString()}{" "}
                            <span className="text-sm font-normal text-neutral-500">
                              Bricks
                            </span>
                          </h3>
                          <p className="mt-1.5 text-xs tabular-nums text-neutral-600">
                            {plot.width} × {plot.height} bounding grid
                          </p>
                        </div>
                        <StatusPill tone={statusTone}>{statusLabel}</StatusPill>
                      </div>
                      <div className="mt-5 flex-1 border-t border-white/[0.07] pt-4">
                        <p className="text-[11px] leading-relaxed text-neutral-600">
                          {plot.hasActiveCreative
                            ? "Your approved artwork stays live while a replacement is reviewed."
                            : plot.hasPendingCreative
                              ? "Your creative is waiting for moderation."
                              : "Choose a region and give it a creative of its own."}
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={anotherOpen}
                        onClick={() => setActiveWorkspacePlot(plot)}
                        className={`mt-4 inline-flex w-full items-center justify-between rounded-xl px-4 py-3 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-35 ${isOpen ? "border border-white/15 bg-white/[0.04] text-white hover:bg-white/[0.07]" : "bg-white text-black hover:bg-neutral-200"}`}
                      >
                        <span>
                          {isOpen
                            ? "Studio open"
                            : plot.hasActiveCreative || plot.hasPendingCreative
                              ? "Manage creatives"
                              : "Create a creative"}
                        </span>
                        <span aria-hidden="true" className="text-base">
                          {isOpen ? "↗" : "→"}
                        </span>
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        )}

        {!isLoading && plots.length === 0 && !error && (
          <section className="overflow-hidden rounded-2xl border border-white/[0.09] bg-[radial-gradient(ellipse_at_top,rgba(255,255,255,0.045),transparent_65%)] px-6 py-16 text-center sm:py-24">
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl border border-white/10 bg-white/[0.025] text-lg text-neutral-500">
              ◇
            </div>
            <h2 className="mt-5 text-xl font-medium tracking-tight text-white">
              Your territory starts here.
            </h2>
            <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-neutral-500">
              Acquire Bricks on The Wall, then come back to turn your space into
              something unmistakably yours.
            </p>
            <Link
              to="/"
              className="mt-6 inline-flex items-center gap-3 rounded-xl bg-white px-5 py-3 text-sm font-semibold text-black transition hover:bg-neutral-200"
            >
              Explore The Wall <span aria-hidden="true">→</span>
            </Link>
          </section>
        )}

        <footer className="mt-12 flex flex-col gap-2 border-t border-white/[0.07] pt-5 text-[10px] uppercase tracking-[0.14em] text-neutral-700 sm:flex-row sm:items-center sm:justify-between">
          <span>Walcay · The Wall</span>
          <span>Creativity is the product.</span>
        </footer>
      </div>
    </main>
  );
}
