import {
  Application,
  Assets,
  Container,
  type FederatedPointerEvent,
  Graphics,
  Sprite,
  type Texture,
} from "pixi.js";
import { useEffect, useRef } from "react";
import { type WallChunkRpcResponse, api } from "../lib/api";
import { useAppStore } from "../store/appStore";

const BRICK_SIZE = 100;
const CHUNK_SIZE = 100;
const CHUNK_PIXELS = BRICK_SIZE * CHUNK_SIZE;
const WORLD_SIZE = 1000 * BRICK_SIZE;

const MIN_SCALE = 0.001;
const MAX_SCALE = 2.0;
const NAV_MODE_THRESHOLD_BRICKS = 600;
const IMAGE_DETAIL_MIN_BRICK_PIXELS = 16;
const IMAGE_DETAIL_UNLOAD_BRICK_PIXELS = 12;
const MAX_DETAIL_CHUNKS = 36;
const MAX_CONCURRENT_CHUNK_REQUESTS = 6;
const MAX_CONCURRENT_IMAGE_REQUESTS = 6;

export function WallCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let isUnmounted = false;
    let isAppInitialized = false;
    let canvasElement: HTMLCanvasElement | null = null;
    let isSpacePressed = false;

    const app = new Application();
    const world = new Container();

    const baseBg = new Graphics();
    const overviewContainer = new Container();
    const chunkLayer = new Container();
    const gridLayer = new Container();
    const gridDetail = new Graphics();
    const gridMid = new Graphics();
    const gridOverview = new Graphics();
    const selectionLayer = new Graphics();
    const marqueeLayer = new Graphics();

    const chunkContainers = new Map<string, Container>();
    const chunkStates = new Map<string, "loading" | "loaded" | "error">();
    const chunkRetries = new Map<string, number>();

    const chunkGenerations = new Map<string, number>();
    const imageGenerations = new Map<string, number>();

    const chunkLoadedIds = new Map<string, number[]>();
    const loadedBricks = new Map<number, WallChunkRpcResponse>();

    const urlRefCounts = new Map<string, number>();
    const chunkActiveUrls = new Map<string, Set<string>>();
    const urlPendingLoads = new Map<string, number>();
    const urlPendingUnloads = new Map<string, Promise<void>>();

    const pendingTextureLoads = new Map<string, Promise<Texture>>();
    const imageTaskQueue: (() => void)[] = [];
    let activeImageRequests = 0;

    let isImageLODActive = false;
    let activeChunkRequests = 0;
    let currentOverviewUrl: string | null = null;
    const pendingChunkRequests: (() => void)[] = [];

    const isChunkLoadedForCoord = (bx: number, by: number): boolean => {
      const cx = Math.floor(bx / 100);
      const cy = Math.floor(by / 100);
      return chunkStates.get(`${cx},${cy}`) === "loaded";
    };

    const processChunkQueue = () => {
      while (
        activeChunkRequests < MAX_CONCURRENT_CHUNK_REQUESTS &&
        pendingChunkRequests.length > 0
      ) {
        const req = pendingChunkRequests.shift();
        if (req) {
          activeChunkRequests++;
          req();
        }
      }
      useAppStore.getState().setLoadingChunks(activeChunkRequests > 0);
    };

    const enqueueChunkRequest = (task: () => Promise<void>) => {
      pendingChunkRequests.push(async () => {
        try {
          await task();
        } finally {
          activeChunkRequests--;
          if (!isUnmounted) processChunkQueue();
        }
      });
      processChunkQueue();
    };

    const processImageTaskQueue = () => {
      while (
        activeImageRequests < MAX_CONCURRENT_IMAGE_REQUESTS &&
        imageTaskQueue.length > 0
      ) {
        const task = imageTaskQueue.shift();
        if (task) {
          activeImageRequests++;
          task();
        }
      }
    };

    const fetchTextureBounded = (url: string): Promise<Texture> => {
      if (Assets.cache.has(url)) return Promise.resolve(Assets.cache.get(url));
      const pending = pendingTextureLoads.get(url);
      if (pending) return pending;

      const p = new Promise<Texture>((resolve, reject) => {
        imageTaskQueue.push(async () => {
          if (isUnmounted || (urlRefCounts.get(url) || 0) <= 0) {
            pendingTextureLoads.delete(url);
            activeImageRequests--;
            if (!isUnmounted) processImageTaskQueue();
            reject(new Error("Image load aborted: no active references"));
            return;
          }

          try {
            const tex = await Assets.load<Texture>(url);
            resolve(tex);
          } catch (e) {
            reject(e);
          } finally {
            pendingTextureLoads.delete(url);
            activeImageRequests--;
            if (!isUnmounted) processImageTaskQueue();
          }
        });
      });
      pendingTextureLoads.set(url, p);
      processImageTaskQueue();
      return p;
    };

    const clampBounds = () => {
      const w = WORLD_SIZE * world.scale.x;
      const h = WORLD_SIZE * world.scale.y;
      const sw = app.screen.width;
      const sh = app.screen.height;

      if (w < sw) world.x = (sw - w) / 2;
      else world.x = Math.max(sw - w, Math.min(0, world.x));

      if (h < sh) world.y = (sh - h) / 2;
      else world.y = Math.max(sh - h, Math.min(0, world.y));
    };

    const safeUnload = (url: string) => {
      if ((urlRefCounts.get(url) || 0) > 0) return;
      if ((urlPendingLoads.get(url) || 0) > 0) return;
      if (urlPendingUnloads.has(url)) return;

      const p = Assets.unload(url)
        .catch(() => {})
        .finally(() => {
          urlPendingUnloads.delete(url);
        });
      urlPendingUnloads.set(url, p);
    };

    const destroyImages = (key: string, chunkContainer: Container) => {
      imageGenerations.set(key, (imageGenerations.get(key) || 0) + 1);
      const imgLayer = chunkContainer.getChildByLabel("imgLayer");
      if (imgLayer) {
        imgLayer.destroy({ children: true });
      }

      const urls = chunkActiveUrls.get(key);
      if (urls) {
        for (const url of urls) {
          const count = (urlRefCounts.get(url) || 1) - 1;
          if (count <= 0) {
            urlRefCounts.delete(url);
            safeUnload(url);
          } else {
            urlRefCounts.set(url, count);
          }
        }
        chunkActiveUrls.delete(key);
      }
    };

    const evictChunk = (key: string) => {
      const containerObj = chunkContainers.get(key);
      if (containerObj) {
        destroyImages(key, containerObj);
        containerObj.destroy({ children: true });
        chunkContainers.delete(key);
      }
      chunkStates.delete(key);
      chunkRetries.delete(key);

      chunkGenerations.set(key, (chunkGenerations.get(key) || 0) + 1);

      const ids = chunkLoadedIds.get(key);
      if (ids) {
        for (const id of ids) loadedBricks.delete(id);
        chunkLoadedIds.delete(key);
      }
    };

    const populateImages = (key: string, chunkContainer: Container) => {
      const ids = chunkLoadedIds.get(key);
      if (!ids) return;

      const imgGen = (imageGenerations.get(key) || 0) + 1;
      imageGenerations.set(key, imgGen);

      let imgLayer = chunkContainer.getChildByLabel("imgLayer") as Container;
      if (imgLayer) {
        imgLayer.removeChildren();
      } else {
        imgLayer = new Container();
        imgLayer.label = "imgLayer";
        chunkContainer.addChild(imgLayer);
      }

      const activeUrls = new Set<string>();
      chunkActiveUrls.set(key, activeUrls);

      const processedBrickIds = new Set<number>();

      for (const id of ids) {
        if (processedBrickIds.has(id)) continue;
        processedBrickIds.add(id);

        const brick = loadedBricks.get(id);
        if (brick?.public_image_url) {
          const url = brick.public_image_url;

          if (!activeUrls.has(url)) {
            activeUrls.add(url);
            urlRefCounts.set(url, (urlRefCounts.get(url) || 0) + 1);
          }

          const doLoad = async () => {
            if (urlPendingUnloads.has(url)) {
              await urlPendingUnloads.get(url);
            }

            urlPendingLoads.set(url, (urlPendingLoads.get(url) || 0) + 1);

            try {
              const texture = await fetchTextureBounded(url);

              if (
                isUnmounted ||
                imageGenerations.get(key) !== imgGen ||
                !isImageLODActive ||
                !chunkContainers.has(key)
              ) {
                return;
              }

              const sprite = new Sprite(texture);
              sprite.x = (brick.x % 100) * BRICK_SIZE;
              sprite.y = (brick.y % 100) * BRICK_SIZE;
              sprite.width = BRICK_SIZE;
              sprite.height = BRICK_SIZE;
              imgLayer.addChild(sprite);
            } catch {
              // Ignore image load failures
            } finally {
              const loads = (urlPendingLoads.get(url) || 1) - 1;
              if (loads <= 0) {
                urlPendingLoads.delete(url);
                if ((urlRefCounts.get(url) || 0) <= 0) {
                  safeUnload(url);
                }
              } else {
                urlPendingLoads.set(url, loads);
              }
            }
          };

          void doLoad();
        }
      }
    };

    const loadChunk = (cx: number, cy: number) => {
      const key = `${cx},${cy}`;
      const state = chunkStates.get(key);

      if (state === "loading" || state === "loaded") return;
      if (state === "error") {
        if (Date.now() < (chunkRetries.get(key) || 0)) return;
        evictChunk(key);
      }

      chunkStates.set(key, "loading");
      const gen = (chunkGenerations.get(key) || 0) + 1;
      chunkGenerations.set(key, gen);

      const chunkContainer = new Container();
      chunkContainer.x = cx * CHUNK_PIXELS;
      chunkContainer.y = cy * CHUNK_PIXELS;
      chunkContainers.set(key, chunkContainer);
      chunkLayer.addChild(chunkContainer);

      enqueueChunkRequest(async () => {
        if (isUnmounted || chunkGenerations.get(key) !== gen) return;

        try {
          const data = await api.getPublicWallChunk(
            cx * 100,
            cx * 100 + 99,
            cy * 100,
            cy * 100 + 99,
          );
          if (isUnmounted || chunkGenerations.get(key) !== gen) return;

          const fg = new Graphics();
          fg.label = "fgLayer";
          chunkContainer.addChild(fg);

          const ids: number[] = [];

          for (const brick of data) {
            const lx = brick.x % 100;
            const ly = brick.y % 100;
            const px = lx * BRICK_SIZE;
            const py = ly * BRICK_SIZE;

            ids.push(brick.id);
            loadedBricks.set(brick.id, brick);

            if (
              brick.is_owned &&
              useAppStore.getState().selectedBrickIds.has(brick.id)
            ) {
              useAppStore.getState().removeBrickSelection(brick.id);
            }

            if (brick.public_image_url) {
              // Texture layer handles image
            } else if (brick.is_listed) {
              fg.rect(px, py, BRICK_SIZE, BRICK_SIZE)
                .fill(0x1e293b)
                .stroke({ color: 0x334155, width: 2, alignment: 0 });
            } else if (brick.is_owned) {
              fg.rect(px, py, BRICK_SIZE, BRICK_SIZE)
                .fill(0x171717)
                .stroke({ color: 0x262626, width: 2, alignment: 0 });
            }
          }

          chunkLoadedIds.set(key, ids);
          chunkStates.set(key, "loaded");
          updateChunks();
        } catch {
          if (isUnmounted || chunkGenerations.get(key) !== gen) return;
          chunkStates.set(key, "error");
          chunkRetries.set(key, Date.now() + 5000);
        }
      });
    };

    const updateChunks = () => {
      if (!isAppInitialized) return;

      const sw = app.screen.width;
      const sh = app.screen.height;
      const visibleWidthBricks = sw / world.scale.x / BRICK_SIZE;
      const visibleHeightBricks = sh / world.scale.y / BRICK_SIZE;

      const isNavMode =
        visibleWidthBricks > NAV_MODE_THRESHOLD_BRICKS ||
        visibleHeightBricks > NAV_MODE_THRESHOLD_BRICKS;

      chunkLayer.visible = !isNavMode;
      overviewContainer.visible = true;

      if (isNavMode) {
        for (const key of Array.from(chunkContainers.keys())) evictChunk(key);
        return;
      }

      const vLeft = -world.x / world.scale.x;
      const vRight = (-world.x + sw) / world.scale.x;
      const vTop = -world.y / world.scale.y;
      const vBottom = (-world.y + sh) / world.scale.y;

      const minCX = Math.max(0, Math.floor(vLeft / CHUNK_PIXELS));
      const maxCX = Math.min(9, Math.floor(vRight / CHUNK_PIXELS));
      const minCY = Math.max(0, Math.floor(vTop / CHUNK_PIXELS));
      const maxCY = Math.min(9, Math.floor(vBottom / CHUNK_PIXELS));

      const brickPixelSize = BRICK_SIZE * world.scale.x;

      if (brickPixelSize > 8) {
        gridDetail.visible = true;
        gridMid.visible = false;
        gridOverview.visible = false;
      } else if (brickPixelSize > 0.8) {
        gridDetail.visible = false;
        gridMid.visible = true;
        gridOverview.visible = false;
      } else {
        gridDetail.visible = false;
        gridMid.visible = false;
        gridOverview.visible = true;
      }

      for (const key of Array.from(chunkContainers.keys())) {
        const [cx, cy] = key.split(",").map(Number);
        if (
          cx < minCX - 2 ||
          cx > maxCX + 2 ||
          cy < minCY - 2 ||
          cy > maxCY + 2
        )
          evictChunk(key);
      }

      const loadMinCX = Math.max(0, minCX - 1);
      const loadMaxCX = Math.min(9, maxCX + 1);
      const loadMinCY = Math.max(0, minCY - 1);
      const loadMaxCY = Math.min(9, maxCY + 1);

      let allVisibleChunksLoaded = true;

      for (let cx = loadMinCX; cx <= loadMaxCX; cx++) {
        for (let cy = loadMinCY; cy <= loadMaxCY; cy++) {
          if (cx >= minCX && cx <= maxCX && cy >= minCY && cy <= maxCY) {
            if (chunkStates.get(`${cx},${cy}`) !== "loaded")
              allVisibleChunksLoaded = false;
          }
          loadChunk(cx, cy);
        }
      }

      if (
        brickPixelSize >= IMAGE_DETAIL_MIN_BRICK_PIXELS &&
        !isImageLODActive
      ) {
        isImageLODActive = true;
      } else if (
        brickPixelSize < IMAGE_DETAIL_UNLOAD_BRICK_PIXELS &&
        isImageLODActive
      ) {
        isImageLODActive = false;
      }

      overviewContainer.visible = !isImageLODActive || !allVisibleChunksLoaded;

      if (chunkContainers.size > MAX_DETAIL_CHUNKS) {
        const centerCX = (minCX + maxCX) / 2;
        const centerCY = (minCY + maxCY) / 2;
        const keys = Array.from(chunkContainers.keys()).sort((a, b) => {
          const [ax, ay] = a.split(",").map(Number);
          const [bx, by] = b.split(",").map(Number);
          return (
            (bx - centerCX) ** 2 +
            (by - centerCY) ** 2 -
            ((ax - centerCX) ** 2 + (ay - centerCY) ** 2)
          );
        });

        let toRemove = chunkContainers.size - MAX_DETAIL_CHUNKS;
        for (const key of keys) {
          if (toRemove <= 0) break;
          const [cx, cy] = key.split(",").map(Number);
          if (cx >= minCX && cx <= maxCX && cy >= minCY && cy <= maxCY)
            continue;
          evictChunk(key);
          toRemove--;
        }
      }

      for (const [key, containerObj] of chunkContainers) {
        const [cx, cy] = key.split(",").map(Number);
        containerObj.visible =
          cx >= minCX && cx <= maxCX && cy >= minCY && cy <= maxCY;
      }

      for (const [key, containerObj] of chunkContainers.entries()) {
        const [cx, cy] = key.split(",").map(Number);
        const isImageActiveZone =
          cx >= minCX - 1 &&
          cx <= maxCX + 1 &&
          cy >= minCY - 1 &&
          cy <= maxCY + 1;

        if (
          isImageLODActive &&
          isImageActiveZone &&
          chunkStates.get(key) === "loaded"
        ) {
          if (!chunkActiveUrls.has(key)) populateImages(key, containerObj);
        } else {
          if (chunkActiveUrls.has(key)) destroyImages(key, containerObj);
        }
      }
    };

    const drawSelection = (ids: Set<number>) => {
      selectionLayer.clear();
      for (const id of ids) {
        const x = id % 1000;
        const y = Math.floor(id / 1000);
        selectionLayer
          .rect(x * BRICK_SIZE, y * BRICK_SIZE, BRICK_SIZE, BRICK_SIZE)
          .fill({ color: 0xffffff, alpha: 0.15 })
          .stroke({ color: 0xffffff, width: 4, alignment: 0 });
      }
    };

    const updateCursor = () => {
      if (!app.stage) return;
      const mode = useAppStore.getState().interactionMode;
      if (isSpacePressed) {
        app.stage.cursor = "grabbing";
      } else if (mode === "select") {
        app.stage.cursor = "crosshair";
      } else {
        app.stage.cursor = "grab";
      }
    };

    let dragStart: {
      x: number;
      y: number;
      worldX: number;
      worldY: number;
      isPan: boolean;
    } | null = null;
    let boxStartWorld: { x: number; y: number } | null = null;
    let hasDragged = false;

    const setupInteraction = () => {
      app.stage.eventMode = "static";
      app.stage.hitArea = { contains: () => true };
      updateCursor();

      app.stage.on("pointerdown", (e: FederatedPointerEvent) => {
        const mode = useAppStore.getState().interactionMode;

        const isPanAction =
          mode === "explore" ||
          e.button === 2 ||
          e.button === 1 ||
          isSpacePressed;

        dragStart = {
          x: e.global.x,
          y: e.global.y,
          worldX: world.x,
          worldY: world.y,
          isPan: isPanAction,
        };
        hasDragged = false;

        if (!isPanAction) {
          const local = world.toLocal(e.global);
          boxStartWorld = { x: local.x, y: local.y };
        } else {
          boxStartWorld = null;
        }
      });

      app.stage.on("pointermove", (e: FederatedPointerEvent) => {
        if (!dragStart) return;

        const dx = e.global.x - dragStart.x;
        const dy = e.global.y - dragStart.y;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) hasDragged = true;

        if (dragStart.isPan) {
          world.x = dragStart.worldX + dx;
          world.y = dragStart.worldY + dy;
          clampBounds();
          updateChunks();
        } else if (boxStartWorld) {
          const currentLocal = world.toLocal(e.global);
          const x = Math.min(boxStartWorld.x, currentLocal.x);
          const y = Math.min(boxStartWorld.y, currentLocal.y);
          const w = Math.abs(boxStartWorld.x - currentLocal.x);
          const h = Math.abs(boxStartWorld.y - currentLocal.y);

          const isDeselect = e.shiftKey;

          marqueeLayer.clear();
          marqueeLayer
            .rect(x, y, w, h)
            .fill({
              color: isDeselect ? 0xef4444 : 0xffffff,
              alpha: isDeselect ? 0.15 : 0.12,
            })
            .stroke({
              color: isDeselect ? 0xef4444 : 0xffffff,
              width: 2,
              alignment: 0,
            });
        }
      });

      const handleUp = (e: FederatedPointerEvent) => {
        if (!dragStart) return;
        marqueeLayer.clear();
        useAppStore.getState().setChunkError(null);

        const isDeselect = e.shiftKey;

        if (dragStart.isPan) {
          if (!hasDragged) {
            const local = world.toLocal(e.global);
            const bx = Math.floor(local.x / BRICK_SIZE);
            const by = Math.floor(local.y / BRICK_SIZE);

            if (bx >= 0 && bx < 1000 && by >= 0 && by < 1000) {
              const brickId = by * 1000 + bx;

              if (isChunkLoadedForCoord(bx, by)) {
                const brick = loadedBricks.get(brickId);
                if (brick) {
                  useAppStore.getState().setActiveBrick(brick);
                } else {
                  useAppStore.getState().setActiveBrick({
                    id: brickId,
                    x: bx,
                    y: by,
                    owner_name: null,
                    public_image_url: null,
                    is_listed: false,
                    is_owned: false,
                  });
                }
              } else {
                loadChunk(Math.floor(bx / 100), Math.floor(by / 100));
                useAppStore.getState().setActiveBrick(null);
              }
            }
          }
        } else if (boxStartWorld) {
          const currentLocal = world.toLocal(e.global);

          if (!hasDragged) {
            // SINGLE CLICK SELECTION
            const bx = Math.floor(currentLocal.x / BRICK_SIZE);
            const by = Math.floor(currentLocal.y / BRICK_SIZE);

            if (bx >= 0 && bx < 1000 && by >= 0 && by < 1000) {
              const brickId = by * 1000 + bx;

              if (!isChunkLoadedForCoord(bx, by)) {
                loadChunk(Math.floor(bx / 100), Math.floor(by / 100));
                useAppStore
                  .getState()
                  .setChunkError(
                    "Loading this area… select again in a moment.",
                  );
                dragStart = null;
                boxStartWorld = null;
                return;
              }

              const brick = loadedBricks.get(brickId);
              const isClaimed = brick
                ? brick.is_owned === true || brick.is_listed === true
                : false;

              if (isDeselect) {
                useAppStore.getState().removeBrickSelection(brickId);
              } else if (!isClaimed) {
                useAppStore.getState().toggleBrickSelection(brickId);
              }
            }
          } else {
            // BOX MARQUEE SELECTION (Unlimited Dimensions, Capped at 10,000)
            const minX = Math.min(boxStartWorld.x, currentLocal.x);
            const maxX = Math.max(boxStartWorld.x, currentLocal.x);
            const minY = Math.min(boxStartWorld.y, currentLocal.y);
            const maxY = Math.max(boxStartWorld.y, currentLocal.y);

            const minBx = Math.max(0, Math.floor(minX / BRICK_SIZE));
            let rawMaxBx = Math.ceil(maxX / BRICK_SIZE) - 1;
            if (rawMaxBx < minBx) rawMaxBx = minBx;
            const maxBx = Math.min(999, rawMaxBx);

            const minBy = Math.max(0, Math.floor(minY / BRICK_SIZE));
            let rawMaxBy = Math.ceil(maxY / BRICK_SIZE) - 1;
            if (rawMaxBy < minBy) rawMaxBy = minBy;
            const maxBy = Math.min(999, rawMaxBy);

            const brickBatch: number[] = [];
            let newAdditions = 0;
            const currentSelection = useAppStore.getState().selectedBrickIds;
            const spaceRemaining = 10000 - currentSelection.size;
            let hitMissingChunk = false;

            // Single Pass: Collect up to 10k bricks safely
            for (let y = minBy; y <= maxBy; y++) {
              for (let x = minBx; x <= maxBx; x++) {
                // Break completely if we reach the quota to save processing
                if (!isDeselect && newAdditions >= spaceRemaining) break;

                const cx = Math.floor(x / 100);
                const cy = Math.floor(y / 100);

                if (chunkStates.get(`${cx},${cy}`) !== "loaded") {
                  loadChunk(cx, cy);
                  hitMissingChunk = true;
                  continue;
                }

                const brickId = y * 1000 + x;
                if (isDeselect) {
                  brickBatch.push(brickId);
                } else {
                  const brick = loadedBricks.get(brickId);
                  const isClaimed = brick
                    ? brick.is_owned === true || brick.is_listed === true
                    : false;

                  if (!isClaimed) {
                    brickBatch.push(brickId);
                    if (!currentSelection.has(brickId)) {
                      newAdditions++;
                    }
                  }
                }
              }
              // Break outer loop as well
              if (!isDeselect && newAdditions >= spaceRemaining) break;
            }

            // Abort only if the chunks we evaluated were unloaded AND we couldn't fulfill the quota.
            if (
              hitMissingChunk &&
              (isDeselect || newAdditions < spaceRemaining)
            ) {
              useAppStore
                .getState()
                .setChunkError("Loading this area… select again in a moment.");
              dragStart = null;
              boxStartWorld = null;
              return;
            }

            if (isDeselect) {
              useAppStore.getState().removeBrickSelections(brickBatch);
            } else {
              useAppStore.getState().addBrickSelections(brickBatch);
              if (newAdditions > 0 && newAdditions >= spaceRemaining) {
                useAppStore
                  .getState()
                  .setChunkError("Selection capped at 10,000 Bricks.");
              }
            }
          }
        }

        dragStart = null;
        boxStartWorld = null;
      };

      app.stage.on("pointerup", handleUp);
      app.stage.on("pointerupoutside", handleUp);
    };

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (!canvasElement || !isAppInitialized) return;

      const zoomFactor = 1.15;
      const direction = e.deltaY > 0 ? -1 : 1;
      const targetScale =
        world.scale.x * (direction > 0 ? zoomFactor : 1 / zoomFactor);
      const clampedScale = Math.max(
        MIN_SCALE,
        Math.min(MAX_SCALE, targetScale),
      );

      const rect = canvasElement.getBoundingClientRect();
      const cssX = e.clientX - rect.left;
      const cssY = e.clientY - rect.top;
      const px = cssX * (app.screen.width / rect.width);
      const py = cssY * (app.screen.height / rect.height);

      const pointerWorldX = (px - world.x) / world.scale.x;
      const pointerWorldY = (py - world.y) / world.scale.y;

      world.scale.set(clampedScale);
      world.x = px - pointerWorldX * clampedScale;
      world.y = py - pointerWorldY * clampedScale;

      clampBounds();
      updateChunks();
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        isSpacePressed = true;
        updateCursor();
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        isSpacePressed = false;
        updateCursor();
      }
    };

    const handleResize = () => {
      if (!isAppInitialized) return;
      app.resize();
      clampBounds();
      updateChunks();
    };

    const init = async () => {
      try {
        await app.init({
          resizeTo: container,
          background: 0x050505,
          resolution: Math.min(window.devicePixelRatio || 1, 2),
          autoDensity: true,
        });
        isAppInitialized = true;
        canvasElement = app.canvas;
      } catch {
        if (!isUnmounted)
          useAppStore.getState().setChunkError("WebGL Initialization Failed.");
        return;
      }

      if (isUnmounted) {
        if (isAppInitialized) app.destroy(true);
        return;
      }

      container.appendChild(canvasElement);

      baseBg.rect(0, 0, WORLD_SIZE, WORLD_SIZE).fill(0x0a0a0a);

      const overviewUrl = api.getOverviewUrl();
      if (overviewUrl) {
        currentOverviewUrl = overviewUrl;
        Assets.load<Texture>(overviewUrl)
          .then((texture) => {
            if (isUnmounted) return;
            const sprite = new Sprite(texture);
            sprite.width = WORLD_SIZE;
            sprite.height = WORLD_SIZE;
            overviewContainer.addChild(sprite);
          })
          .catch((err) =>
            console.warn("Wall overview not loaded yet:", err.message),
          );
      }

      gridDetail
        .rect(0, 0, WORLD_SIZE, WORLD_SIZE)
        .stroke({ color: 0x222222, pixelLine: true });
      for (let i = 1; i < 1000; i++) {
        gridDetail.moveTo(i * BRICK_SIZE, 0).lineTo(i * BRICK_SIZE, WORLD_SIZE);
        gridDetail.moveTo(0, i * BRICK_SIZE).lineTo(WORLD_SIZE, i * BRICK_SIZE);
      }
      gridDetail.stroke({ color: 0x141414, pixelLine: true });

      gridMid
        .rect(0, 0, WORLD_SIZE, WORLD_SIZE)
        .stroke({ color: 0x333333, pixelLine: true });
      for (let i = 1; i < 100; i++) {
        gridMid
          .moveTo(i * 10 * BRICK_SIZE, 0)
          .lineTo(i * 10 * BRICK_SIZE, WORLD_SIZE);
        gridMid
          .moveTo(0, i * 10 * BRICK_SIZE)
          .lineTo(WORLD_SIZE, i * 10 * BRICK_SIZE);
      }
      gridMid.stroke({ color: 0x1a1a1a, pixelLine: true });

      gridOverview
        .rect(0, 0, WORLD_SIZE, WORLD_SIZE)
        .stroke({ color: 0x444444, pixelLine: true });
      for (let i = 1; i < 100; i++) {
        gridOverview
          .moveTo(i * 100 * BRICK_SIZE, 0)
          .lineTo(i * 100 * BRICK_SIZE, WORLD_SIZE);
        gridOverview
          .moveTo(0, i * 100 * BRICK_SIZE)
          .lineTo(WORLD_SIZE, i * 100 * BRICK_SIZE);
      }
      gridOverview.stroke({ color: 0x222222, pixelLine: true });

      gridLayer.addChild(gridDetail);
      gridLayer.addChild(gridMid);
      gridLayer.addChild(gridOverview);

      world.addChild(baseBg);
      world.addChild(overviewContainer);
      world.addChild(chunkLayer);
      world.addChild(gridLayer);
      world.addChild(selectionLayer);
      world.addChild(marqueeLayer);

      app.stage.addChild(world);

      const targetBricks = 120;
      const startScale =
        Math.max(app.screen.width, app.screen.height) /
        (targetBricks * BRICK_SIZE);
      world.scale.set(Math.max(MIN_SCALE, Math.min(MAX_SCALE, startScale)));

      world.x = app.screen.width / 2 - (WORLD_SIZE / 2) * world.scale.x;
      world.y = app.screen.height / 2 - (WORLD_SIZE / 2) * world.scale.y;

      clampBounds();
      setupInteraction();

      canvasElement.addEventListener("wheel", handleWheel, { passive: false });
      window.addEventListener("keydown", handleKeyDown);
      window.addEventListener("keyup", handleKeyUp);
      window.addEventListener("resize", handleResize);

      updateChunks();
    };

    let lastSet = useAppStore.getState().selectedBrickIds;
    let lastMode = useAppStore.getState().interactionMode;
    drawSelection(lastSet);

    const unsubscribeStore = useAppStore.subscribe((state) => {
      if (state.selectedBrickIds !== lastSet) {
        lastSet = state.selectedBrickIds;
        drawSelection(lastSet);
      }
      if (state.interactionMode !== lastMode) {
        lastMode = state.interactionMode;
        updateCursor();
      }
    });

    init();

    return () => {
      isUnmounted = true;
      unsubscribeStore();

      if (canvasElement) {
        canvasElement.removeEventListener("wheel", handleWheel);
      }
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("resize", handleResize);

      pendingChunkRequests.length = 0;
      imageTaskQueue.length = 0;
      pendingTextureLoads.clear();

      for (const key of Array.from(chunkContainers.keys())) evictChunk(key);

      chunkGenerations.clear();
      imageGenerations.clear();

      if (currentOverviewUrl) Assets.unload(currentOverviewUrl).catch(() => {});

      if (isAppInitialized) {
        app.destroy(true);
        isAppInitialized = false;
      }
    };
  }, []);

  return <div ref={containerRef} className="absolute inset-0 touch-none" />;
}
