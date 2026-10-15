import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import sharp from "sharp";

dotenv.config();

const SUPABASE_URL = process.env.WALCAY_SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.WALCAY_SUPABASE_SERVICE_ROLE_KEY;
const WORKER_ID = process.env.WALL_WORKER_ID ?? `${hostname()}-${process.pid}`;
// Safe by default: local runs only render a preview and never mutate Supabase.
// Set WALL_WORKER_MODE=process explicitly only in a trusted production worker.
const WORKER_MODE = process.env.WALL_WORKER_MODE?.trim() || "dry-run";
const PREVIEW_OUTPUT_PATH = resolve(
  process.env.WALL_WORKER_OUTPUT_PATH ?? "./artifacts/wall-overview-preview.webp",
);
const BUCKET = "creative_public";
const WORLD_BRICKS = 1000;
const OVERVIEW_SIZE = 2048;
const BRICK_PX = OVERVIEW_SIZE / WORLD_BRICKS;
const CHUNK_BRICKS = 100;
const LEASE_SECONDS = 600;
const HEARTBEAT_MS = 25_000;
const IMAGE_CONCURRENCY = 4;
const MAX_SOURCE_PIXELS = 80_000_000;

if (WORKER_MODE !== "dry-run" && WORKER_MODE !== "process") {
  throw new Error("WALL_WORKER_MODE must be either 'dry-run' or 'process'.");
}

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error(
    "Missing WALCAY_SUPABASE_URL (or VITE_SUPABASE_URL) and/or WALCAY_SUPABASE_SERVICE_ROLE_KEY.",
  );
}

const supabase: SupabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type WorkerJob = {
  job_id: number;
  target_revision: number;
  lease_token: string;
  attempts: number;
  requested_revision: number;
  published_revision: number;
};

type WallBrick = {
  id: number;
  x: number;
  y: number;
  creative_id: string;
  public_storage_path: string;
};

type CreativeGroup = {
  creativeId: string;
  storagePath: string;
  bricks: WallBrick[];
};

function assertBrick(row: WallBrick): void {
  if (
    !Number.isInteger(row.id) ||
    !Number.isInteger(row.x) ||
    !Number.isInteger(row.y) ||
    row.x < 0 || row.x >= WORLD_BRICKS ||
    row.y < 0 || row.y >= WORLD_BRICKS ||
    row.id !== row.y * WORLD_BRICKS + row.x ||
    typeof row.creative_id !== "string" ||
    typeof row.public_storage_path !== "string"
  ) {
    throw new Error(`Invalid active Wall placement returned for Brick ${String(row?.id)}.`);
  }
}

function normalizeApprovedPath(rawPath: string): string {
  let path = rawPath.trim();

  // Legacy data may contain a public object URL. Convert only URLs that point
  // to this project's creative_public bucket; never fetch arbitrary URLs.
  if (/^https?:\/\//i.test(path)) {
    const parsed = new URL(path);
    const marker = "/storage/v1/object/public/creative_public/";
    const index = parsed.pathname.indexOf(marker);
    if (index < 0) {
      throw new Error("Creative URL is not a creative_public storage object.");
    }
    path = decodeURIComponent(parsed.pathname.slice(index + marker.length));
  }

  if (
    !path.startsWith("approved/") ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Rejected unsafe approved creative storage path: ${rawPath}`);
  }

  return path;
}

async function rpcOrThrow<T>(
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data as T;
}

async function fetchActivePlacements(job: WorkerJob): Promise<WallBrick[]> {
  const all: WallBrick[] = [];

  for (let cx = 0; cx < WORLD_BRICKS; cx += CHUNK_BRICKS) {
    for (let cy = 0; cy < WORLD_BRICKS; cy += CHUNK_BRICKS) {
      const chunk = await rpcOrThrow<WallBrick[]>("wall_worker_get_chunk", {
        p_min_x: cx,
        p_max_x: Math.min(cx + CHUNK_BRICKS - 1, WORLD_BRICKS - 1),
        p_min_y: cy,
        p_max_y: Math.min(cy + CHUNK_BRICKS - 1, WORLD_BRICKS - 1),
      });

      if (!Array.isArray(chunk)) {
        throw new Error("wall_worker_get_chunk returned a non-array JSON value.");
      }

      for (const row of chunk) {
        assertBrick(row);
        row.public_storage_path = normalizeApprovedPath(row.public_storage_path);
        all.push(row);
      }

      if ((cx * WORLD_BRICKS + cy) % 300 === 0) {
        console.log(
          `Revision ${job.target_revision}: scanned chunk x=${cx}, y=${cy}; active Bricks collected=${all.length}.`,
        );
      }
    }
  }

  // A Brick can only appear once in the 100 non-overlapping chunks.
  const seenBrickIds = new Set<number>();
  for (const row of all) {
    if (seenBrickIds.has(row.id)) {
      throw new Error(`Duplicate Brick ${row.id} returned by Wall chunk RPC.`);
    }
    seenBrickIds.add(row.id);
  }

  return all;
}

function groupByCreative(bricks: WallBrick[]): CreativeGroup[] {
  const groups = new Map<string, CreativeGroup>();

  for (const brick of bricks) {
    const existing = groups.get(brick.creative_id);
    if (existing) {
      if (existing.storagePath !== brick.public_storage_path) {
        throw new Error(`Creative ${brick.creative_id} has inconsistent public paths.`);
      }
      existing.bricks.push(brick);
    } else {
      groups.set(brick.creative_id, {
        creativeId: brick.creative_id,
        storagePath: brick.public_storage_path,
        bricks: [brick],
      });
    }
  }

  return [...groups.values()];
}

async function downloadCreative(path: string): Promise<Buffer> {
  const { data, error } = await supabase.storage.from(BUCKET).download(path);
  if (error || !data) {
    throw new Error(`Cannot download approved creative '${path}': ${error?.message ?? "empty response"}`);
  }
  const bytes = Buffer.from(await data.arrayBuffer());
  if (bytes.length < 1 || bytes.length > 5_500_000) {
    throw new Error(`Approved creative '${path}' has an unexpected file size (${bytes.length} bytes).`);
  }
  return bytes;
}

function blendCreativePixels(
  master: Buffer,
  resized: Buffer,
  renderWidth: number,
  regionLeft: number,
  regionTop: number,
  brick: WallBrick,
): void {
  const left = Math.round(brick.x * BRICK_PX);
  const top = Math.round(brick.y * BRICK_PX);
  const right = Math.round((brick.x + 1) * BRICK_PX);
  const bottom = Math.round((brick.y + 1) * BRICK_PX);
  const localLeft = left - regionLeft;
  const localTop = top - regionTop;
  const width = right - left;
  const height = bottom - top;

  if (
    width < 1 || height < 1 || localLeft < 0 || localTop < 0 ||
    localLeft + width > renderWidth
  ) {
    throw new Error(`Invalid rendered geometry for Brick ${brick.id}.`);
  }

  for (let dy = 0; dy < height; dy++) {
    for (let dx = 0; dx < width; dx++) {
      const sourceIndex = ((localTop + dy) * renderWidth + localLeft + dx) * 4;
      const destX = left + dx;
      const destY = top + dy;
      const destIndex = (destY * OVERVIEW_SIZE + destX) * 4;
      const alpha = resized[sourceIndex + 3] / 255;

      if (alpha >= 1) {
        master[destIndex] = resized[sourceIndex];
        master[destIndex + 1] = resized[sourceIndex + 1];
        master[destIndex + 2] = resized[sourceIndex + 2];
      } else if (alpha > 0) {
        master[destIndex] = Math.round(
          resized[sourceIndex] * alpha + master[destIndex] * (1 - alpha),
        );
        master[destIndex + 1] = Math.round(
          resized[sourceIndex + 1] * alpha + master[destIndex + 1] * (1 - alpha),
        );
        master[destIndex + 2] = Math.round(
          resized[sourceIndex + 2] * alpha + master[destIndex + 2] * (1 - alpha),
        );
      }
      master[destIndex + 3] = 255;
    }
  }
}

async function renderCreative(master: Buffer, group: CreativeGroup): Promise<void> {
  const xs = group.bricks.map((brick) => brick.x);
  const ys = group.bricks.map((brick) => brick.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const regionLeft = Math.round(minX * BRICK_PX);
  const regionTop = Math.round(minY * BRICK_PX);
  const regionRight = Math.round((maxX + 1) * BRICK_PX);
  const regionBottom = Math.round((maxY + 1) * BRICK_PX);
  const renderWidth = regionRight - regionLeft;
  const renderHeight = regionBottom - regionTop;

  if (renderWidth < 1 || renderHeight < 1) {
    throw new Error(`Creative ${group.creativeId} has an empty rendered region.`);
  }

  const input = await downloadCreative(group.storagePath);
  const metadata = await sharp(input, { limitInputPixels: MAX_SOURCE_PIXELS }).metadata();
  if (
    !metadata.width || !metadata.height ||
    metadata.width * metadata.height > MAX_SOURCE_PIXELS ||
    !["jpeg", "png", "webp", "avif", "tiff"].includes(metadata.format ?? "")
  ) {
    throw new Error(`Creative ${group.creativeId} has unsupported or unsafe image metadata.`);
  }

  // One creative image spans the selected territory's bounding box. Only its
  // assigned Bricks are copied to the Wall, so irregular connected shapes are
  // clipped to their actual Brick selection instead of bleeding into neighbors.
  const resized = await sharp(input, { limitInputPixels: MAX_SOURCE_PIXELS })
    .rotate()
    .resize(renderWidth, renderHeight, { fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer();

  if (resized.length !== renderWidth * renderHeight * 4) {
    throw new Error(`Creative ${group.creativeId} produced unexpected pixel data.`);
  }

  for (const brick of group.bricks) {
    blendCreativePixels(master, resized, renderWidth, regionLeft, regionTop, brick);
  }
}

async function mapLimit<T>(
  items: T[],
  concurrency: number,
  callback: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= items.length) return;
        await callback(items[index]!, index);
      }
    }),
  );
}

async function renderMaster(job: WorkerJob): Promise<Buffer> {
  const bricks = await fetchActivePlacements(job);
  const groups = groupByCreative(bricks);
  console.log(
    `Revision ${job.target_revision}: ${bricks.length} active Bricks across ${groups.length} creatives.`,
  );

  const master = Buffer.alloc(OVERVIEW_SIZE * OVERVIEW_SIZE * 4);
  for (let i = 0; i < master.length; i += 4) {
    master[i] = 10;
    master[i + 1] = 10;
    master[i + 2] = 10;
    master[i + 3] = 255;
  }

  let completed = 0;
  await mapLimit(groups, IMAGE_CONCURRENCY, async (group) => {
    await renderCreative(master, group);
    completed++;
    if (completed % 25 === 0 || completed === groups.length) {
      console.log(`Rendered ${completed}/${groups.length} creatives.`);
    }
  });

  const output = await sharp(master, {
    raw: { width: OVERVIEW_SIZE, height: OVERVIEW_SIZE, channels: 4 },
  })
    .webp({ quality: 85, effort: 4 })
    .toBuffer();

  const finalMetadata = await sharp(output).metadata();
  if (
    finalMetadata.format !== "webp" ||
    finalMetadata.width !== OVERVIEW_SIZE ||
    finalMetadata.height !== OVERVIEW_SIZE ||
    output.length < 1 || output.length > 50_000_000
  ) {
    throw new Error("Generated master failed WebP dimensions/size validation.");
  }

  return output;
}

async function runOnce(): Promise<void> {
  if (WORKER_MODE === "dry-run") {
    console.log("LOCAL DRY RUN: no job claim, heartbeat, upload, or database write will be performed.");
    const previewJob: WorkerJob = {
      job_id: 0,
      target_revision: 0,
      lease_token: "dry-run-no-lease",
      attempts: 0,
      requested_revision: 0,
      published_revision: 0,
    };
    const preview = await renderMaster(previewJob);
    await mkdir(dirname(PREVIEW_OUTPUT_PATH), { recursive: true });
    await writeFile(PREVIEW_OUTPUT_PATH, preview);
    const digest = createHash("sha256").update(preview).digest("hex");
    console.log(`Local preview written to: ${PREVIEW_OUTPUT_PATH}`);
    console.log(`Preview: ${OVERVIEW_SIZE}x${OVERVIEW_SIZE} WebP, ${preview.length} bytes, SHA-256 ${digest}.`);
    console.log("Review the image before enabling production processing.");
    return;
  }

  const jobRows = await rpcOrThrow<WorkerJob[]>("wall_worker_claim_job", {
    p_worker_id: WORKER_ID,
    p_lease_seconds: LEASE_SECONDS,
  });
  const job = Array.isArray(jobRows) ? jobRows[0] : undefined;

  if (!job) {
    console.log("No current Wall rebuild is ready. Nothing to do.");
    return;
  }

  console.log(
    `Claimed Wall revision ${job.target_revision} (job ${job.job_id}, attempt ${job.attempts}).`,
  );

  let leaseLost = false;
  let heartbeatRunning = false;
  let uploadedPath: string | null = null;
  let completionAttempted = false;

  const heartbeatTimer = setInterval(() => {
    if (heartbeatRunning || leaseLost) return;
    heartbeatRunning = true;
    void (async () => {
      try {
        const stillOwned = await rpcOrThrow<boolean>("wall_worker_heartbeat", {
          p_job_id: job.job_id,
          p_target_revision: job.target_revision,
          p_lease_token: job.lease_token,
          p_lease_seconds: LEASE_SECONDS,
        });
        if (stillOwned !== true) {
          leaseLost = true;
          console.error("Worker lease lost or revision superseded.");
        }
      } catch (error) {
        // A transient heartbeat error is logged; completion also performs a
        // revision and lease-token guard. Never assume a heartbeat succeeded.
        console.error("Heartbeat failed:", errorMessage(error));
      } finally {
        heartbeatRunning = false;
      }
    })();
  }, HEARTBEAT_MS);
  heartbeatTimer.unref();

  try {
    const finalWebp = await renderMaster(job);
    if (leaseLost) throw new Error("Worker lost its lease during rendering.");

    const digest = createHash("sha256").update(finalWebp).digest("hex");
    uploadedPath = `wall/builds/revision-${job.target_revision}/${randomUUID()}.webp`;

    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(uploadedPath, finalWebp, {
        contentType: "image/webp",
        cacheControl: "31536000",
        upsert: false,
      });
    if (uploadError) throw new Error(`Master upload failed: ${uploadError.message}`);

    if (leaseLost) throw new Error("Worker lost its lease before publication.");

    completionAttempted = true;
    const published = await rpcOrThrow<boolean>("wall_worker_complete_job", {
      p_job_id: job.job_id,
      p_target_revision: job.target_revision,
      p_lease_token: job.lease_token,
      p_storage_path: uploadedPath,
      p_sha256: digest,
      p_width: OVERVIEW_SIZE,
      p_height: OVERVIEW_SIZE,
      p_size_bytes: finalWebp.length,
    });

    if (published !== true) {
      // A definitive false means the staged object is not the published image.
      const stalePath = uploadedPath;
      uploadedPath = null;
      const { error: removeError } = await supabase.storage.from(BUCKET).remove([stalePath]);
      if (removeError) console.error("Could not remove superseded staged image:", removeError.message);
      console.log(`Revision ${job.target_revision} was superseded and was not published.`);
      return;
    }

    console.log(
      `Published revision ${job.target_revision}: ${uploadedPath} (${finalWebp.length} bytes, SHA-256 ${digest}).`,
    );
    uploadedPath = null;
  } catch (error) {
    console.error("Wall rebuild failed:", errorMessage(error));

    // If completion RPC returned a transport error, its database transaction
    // may have committed despite the lost response; retain the staged object.
    if (uploadedPath && !completionAttempted) {
      const { error: removeError } = await supabase.storage.from(BUCKET).remove([uploadedPath]);
      if (removeError) console.error("Staged image cleanup failed:", removeError.message);
    }

    if (!leaseLost) {
      try {
        const recorded = await rpcOrThrow<boolean>("wall_worker_fail_job", {
          p_job_id: job.job_id,
          p_target_revision: job.target_revision,
          p_lease_token: job.lease_token,
          p_error: errorMessage(error),
        });
        if (!recorded) console.warn("Failure was not recorded because this worker no longer owns the job.");
      } catch (reportError) {
        console.error("Could not report Wall rebuild failure:", errorMessage(reportError));
      }
    }

    process.exitCode = 1;
  } finally {
    clearInterval(heartbeatTimer);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

runOnce().catch((error: unknown) => {
  console.error("Wall worker exited unexpectedly:", errorMessage(error));
  process.exitCode = 1;
});
