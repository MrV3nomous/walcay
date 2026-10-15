import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import sharp from "sharp";

dotenv.config();

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.WALCAY_SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error(
    "ERROR: Missing VITE_SUPABASE_URL or WALCAY_SUPABASE_SERVICE_ROLE_KEY in environment.",
  );
  process.exit(1);
}

// The generator intentionally uses the same public Wall RPC contract as the frontend,
// so it uses the exact same public projection of live Wall data.
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

interface WallChunkRpcResponse {
  id: number;
  x: number;
  y: number;
  owner_name: string | null;
  public_image_url: string | null;
  is_listed: boolean;
  is_owned: boolean;
}

async function generateOverview() {
  console.log("Fetching active Wall geometry via public RPC contract...");

  const OVERVIEW_SIZE = 2048;
  const BRICK_PX = OVERVIEW_SIZE / 1000;

  // The master RGBA buffer is fixed at 16MB. Metadata maps scale O(N) with occupied bricks.
  const masterBuffer = Buffer.alloc(OVERVIEW_SIZE * OVERVIEW_SIZE * 4);
  for (let i = 0; i < masterBuffer.length; i += 4) {
    masterBuffer[i] = 10; // R (0x0a)
    masterBuffer[i + 1] = 10; // G (0x0a)
    masterBuffer[i + 2] = 10; // B (0x0a)
    masterBuffer[i + 3] = 255; // A
  }

  const uniqueUrls = new Set<string>();
  const brickData: { x: number; y: number; url: string }[] = [];

  for (let cx = 0; cx < 10; cx++) {
    for (let cy = 0; cy < 10; cy++) {
      const { data, error } = await supabase.rpc("get_public_wall_chunk", {
        p_min_x: cx * 100,
        p_max_x: cx * 100 + 99,
        p_min_y: cy * 100,
        p_max_y: cy * 100 + 99,
      });

      if (error) {
        console.error("Database RPC error:", error);
        process.exit(1);
      }

      if (data) {
        const rows = data as unknown as WallChunkRpcResponse[];
        for (const brick of rows) {
          if (brick.public_image_url) {
            brickData.push({
              x: brick.x,
              y: brick.y,
              url: brick.public_image_url,
            });
            uniqueUrls.add(brick.public_image_url);
          }
        }
      }
    }
  }

  console.log(
    `Found ${brickData.length} active bricks across ${uniqueUrls.size} unique creatives.`,
  );

  const urlToBricks = new Map<string, { x: number; y: number }[]>();
  for (const b of brickData) {
    const list = urlToBricks.get(b.url);
    if (!list) {
      urlToBricks.set(b.url, [{ x: b.x, y: b.y }]);
    } else {
      list.push({ x: b.x, y: b.y });
    }
  }

  let processedCount = 0;

  for (const [url, bricks] of urlToBricks.entries()) {
    processedCount++;
    console.log(`Processing creative ${processedCount}/${uniqueUrls.size}...`);

    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const imageBuffer = Buffer.from(await response.arrayBuffer());

      const tile2x2 = await sharp(imageBuffer)
        .resize(2, 2, { fit: "fill" })
        .ensureAlpha()
        .raw()
        .toBuffer();
      const tile3x2 = await sharp(imageBuffer)
        .resize(3, 2, { fit: "fill" })
        .ensureAlpha()
        .raw()
        .toBuffer();
      const tile2x3 = await sharp(imageBuffer)
        .resize(2, 3, { fit: "fill" })
        .ensureAlpha()
        .raw()
        .toBuffer();
      const tile3x3 = await sharp(imageBuffer)
        .resize(3, 3, { fit: "fill" })
        .ensureAlpha()
        .raw()
        .toBuffer();

      for (const b of bricks) {
        const left = Math.round(b.x * BRICK_PX);
        const top = Math.round(b.y * BRICK_PX);
        const right = Math.round((b.x + 1) * BRICK_PX);
        const bottom = Math.round((b.y + 1) * BRICK_PX);
        const w = right - left;
        const h = bottom - top;

        let tile = tile2x2;
        if (w === 3 && h === 3) tile = tile3x3;
        else if (w === 3 && h === 2) tile = tile3x2;
        else if (w === 2 && h === 3) tile = tile2x3;

        for (let dy = 0; dy < h; dy++) {
          for (let dx = 0; dx < w; dx++) {
            const destX = left + dx;
            const destY = top + dy;
            if (
              destX < 0 ||
              destX >= OVERVIEW_SIZE ||
              destY < 0 ||
              destY >= OVERVIEW_SIZE
            )
              continue;

            const destIdx = (destY * OVERVIEW_SIZE + destX) * 4;
            const srcIdx = (dy * w + dx) * 4;

            const alpha = tile[srcIdx + 3] / 255;
            if (alpha > 0) {
              masterBuffer[destIdx] = Math.round(
                tile[srcIdx] * alpha + masterBuffer[destIdx] * (1 - alpha),
              );
              masterBuffer[destIdx + 1] = Math.round(
                tile[srcIdx + 1] * alpha +
                  masterBuffer[destIdx + 1] * (1 - alpha),
              );
              masterBuffer[destIdx + 2] = Math.round(
                tile[srcIdx + 2] * alpha +
                  masterBuffer[destIdx + 2] * (1 - alpha),
              );
              masterBuffer[destIdx + 3] = 255;
            }
          }
        }
      }
    } catch (err) {
      console.error(
        `\nCRITICAL FAILURE: Failed to process creative image ${url}`,
      );
      console.error(err);
      console.error(
        "Aborting generator entirely to prevent partial representation.",
      );
      console.error(
        "The existing overview image has not been overwritten and will remain untouched.\n",
      );
      process.exit(1);
    }
  }

  console.log("Encoding final 2048x2048 WebP...");
  const finalWebp = await sharp(masterBuffer, {
    raw: { width: OVERVIEW_SIZE, height: OVERVIEW_SIZE, channels: 4 },
  })
    .webp({ quality: 85 })
    .toBuffer();

  console.log("Validating generated overview output...");
  const metadata = await sharp(finalWebp).metadata();
  if (
    metadata.width !== OVERVIEW_SIZE ||
    metadata.height !== OVERVIEW_SIZE ||
    metadata.format !== "webp"
  ) {
    console.error(
      `CRITICAL FAILURE: Validation failed. Generated image is ${metadata.width}x${metadata.height} ${metadata.format}. Expected ${OVERVIEW_SIZE}x${OVERVIEW_SIZE} webp.`,
    );
    console.error(
      "Aborting generator entirely. The existing overview image will remain untouched.\n",
    );
    process.exit(1);
  }

  console.log("Uploading validated overview to Supabase...");
  const { error: uploadError } = await supabase.storage
    .from("creative_public")
    .upload("wall/overview.webp", finalWebp, {
      contentType: "image/webp",
      upsert: true,
      cacheControl: "60",
    });

  if (uploadError) {
    console.error("Upload failed:", uploadError.message);
    process.exit(1);
  }

  console.log(
    "Overview successfully deployed to: creative_public/wall/overview.webp",
  );
}

generateOverview();
