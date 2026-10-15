import type { PostgrestError } from "@supabase/supabase-js";
import { supabase } from "./supabase";

export type WallChunkRpcResponse = {
  id: number;
  x: number;
  y: number;
  owner_name: string | null;
  public_image_url: string | null;
  is_listed: boolean;
  is_owned: boolean;
};

export type PendingCreative = {
  id: string;
  owner_id: string;
  status: string;
  upload_storage_path: string;
  public_storage_path: string | null;
  created_at: string;
  category: string | null;
  intended_audience: string | null;
  destination_url: string | null;
  preview_url: string | null;
};

export interface CreativeSubmissionMetadata {
  category: string;
  intendedAudience: string;
  destinationUrl: string;
}

export type PrivateProfile = {
  id: string;
};

export interface ManagedPlot {
  plotKey: number;
  brickCount: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  height: number;
  brickIds: number[];
  hasActiveCreative: boolean;
  hasPendingCreative: boolean;
}

interface DbPlotRow {
  plot_key: number;
  brick_count: number;
  min_x: number;
  max_x: number;
  min_y: number;
  max_y: number;
  brick_ids: number[];
  has_active_creative: boolean;
  has_pending_creative: boolean;
}

/** Creative record restored from Supabase for the current user's Plot. */
export interface ManagedCreative {
  id: string;
  status: string;
  uploadStoragePath: string;
  publicStoragePath: string | null;
  createdAt: string;
  category: string | null;
  intendedAudience: string | null;
  destinationUrl: string | null;
  brickIds: number[];
  previewUrl: string | null;
}

interface DbManagedCreativeRow {
  creative_id: string;
  creative_status: string;
  upload_storage_path: string;
  public_storage_path: string | null;
  created_at: string;
  category: string | null;
  intended_audience: string | null;
  destination_url: string | null;
  brick_ids: number[];
}

export interface RazorpayOrderResponse {
  intentId: string;
  orderId: string;
  amount: number;
  key: string;
}

export interface PaymentVerificationResult {
  success: boolean;
  status: string;
  orphaned?: boolean;
  message?: string;
  intent_id?: string;
}

export interface PaymentStatusResult {
  status: string;
  failure_reason: string | null;
}

export class ApiError extends Error {
  code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
}

const handleRpc = async <T>(
  request: PromiseLike<{
    data: unknown;
    error: PostgrestError | null;
  }>,
): Promise<T> => {
  const { data, error } = await request;

  if (error) {
    throw new ApiError(
      error.message || "An RPC error occurred.",
      error.code || "db_error",
    );
  }

  return data as T;
};

type JsonRecord = Record<string, unknown>;

const isJsonRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const readJson = async (res: Response): Promise<JsonRecord> => {
  try {
    const value: unknown = await res.json();
    return isJsonRecord(value) ? value : {};
  } catch {
    return {};
  }
};

const handleFetchResponse = async (res: Response): Promise<JsonRecord> => {
  const data = await readJson(res);

  if (!res.ok) {
    throw new ApiError(
      readString(data.message) ??
        readString(data.error) ??
        `HTTP Error ${res.status}`,
      readString(data.error) ?? "network_error",
    );
  }

  return data;
};

export const getPublicUrl = (path: string | null) => {
  if (!path) return null;

  if (path.startsWith("http")) {
    return path;
  }

  return supabase.storage.from("creative_public").getPublicUrl(path).data
    .publicUrl;
};

type RpcPayloads = {
  get_public_wall_chunk: {
    p_min_x: number;
    p_max_x: number;
    p_min_y: number;
    p_max_y: number;
  };

  reserve_bricks: {
    p_brick_ids: number[];
  };

  create_secondary_listing: {
    p_brick_ids: number[];
    p_total_asking_price: number;
  };

  cancel_secondary_listing: {
    p_listing_id: string;
  };

  submit_creative_to_bricks: {
    p_brick_ids: number[];
    p_upload_storage_path: string;
    p_category: string;
    p_intended_audience: string;
    p_destination_url: string;
  };

  get_my_assigned_creatives: {
    p_brick_ids: number[];
  };

  get_my_private_profile: Record<string, never>;
  get_public_base_price: Record<string, never>;
  is_current_user_admin: Record<string, never>;
  get_my_plots: Record<string, never>;
};

const rpcWithArgs = supabase.rpc.bind(supabase) as unknown as <
  T extends keyof RpcPayloads,
>(
  fn: T,
  args?: RpcPayloads[T],
) => PromiseLike<{
  data: unknown;
  error: PostgrestError | null;
}>;

const MAX_CREATIVE_FILE_SIZE = 5 * 1024 * 1024;

const CREATIVE_FILE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

type CreativeModerationRequest =
  | { action: "list" }
  | { action: "approve" | "reject"; creativeId: string };

interface CreativeModerationResponse {
  ok: boolean;
  action?: string;
  creativeId?: string;
  recovered?: boolean;
  creatives?: PendingCreative[];
}

const invokeCreativeModeration = async <T extends CreativeModerationResponse>(
  body: CreativeModerationRequest,
): Promise<T> => {
  const { data, error } = await supabase.functions.invoke<T>(
    "creative-moderation",
    { body },
  );

  if (error) {
    let message = error.message || "Creative moderation request failed.";
    let code = "creative_moderation_error";

    // Supabase HTTP function errors can contain the JSON response
    // returned by the Edge Function.
    if ("context" in error && error.context instanceof Response) {
      const errorBody = await readJson(error.context);

      message =
        readString(errorBody.message) ?? readString(errorBody.error) ?? message;

      code = readString(errorBody.error) ?? code;
    }

    throw new ApiError(message, code);
  }

  if (!isJsonRecord(data)) {
    throw new ApiError(
      "The moderation service returned an invalid response.",
      "invalid_moderation_response",
    );
  }

  if (data.ok !== true) {
    throw new ApiError(
      readString(data.message) ??
        "The moderation service could not complete the request.",
      readString(data.error) ?? "moderation_request_failed",
    );
  }

  return data as T;
};

export const api = {
  // ==========================================================
  // AUTHENTICATION
  // ==========================================================

  signIn: async (email: string, password: string) =>
    supabase.auth.signInWithPassword({ email, password }),

  signUp: async (email: string, password: string) =>
    supabase.auth.signUp({ email, password }),

  signOut: () => supabase.auth.signOut(),

  // ==========================================================
  // PRIVATE CREATIVE STORAGE
  // ==========================================================

  uploadPrivateCreative: async (file: File): Promise<string> => {
    const extension = CREATIVE_FILE_EXTENSIONS[file.type];

    if (!extension) {
      throw new ApiError(
        "Use a JPEG, PNG, or WebP image.",
        "invalid_image_type",
      );
    }

    if (file.size <= 0 || file.size > MAX_CREATIVE_FILE_SIZE) {
      throw new ApiError(
        "The image must be larger than 0 bytes and no larger than 5 MB.",
        "invalid_image_size",
      );
    }

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError) {
      throw new ApiError(authError.message, "auth_error");
    }

    if (!user) {
      throw new ApiError("Not authenticated.", "unauthorized");
    }

    const path = `${user.id}/${crypto.randomUUID()}.${extension}`;

    const { data, error } = await supabase.storage
      .from("creative_uploads")
      .upload(path, file, {
        contentType: file.type,
        cacheControl: "3600",
        upsert: false,
      });

    if (error) {
      throw new ApiError(error.message, "storage_upload_error");
    }

    return data.path;
  },

  getPrivateSignedUrl: async (path: string): Promise<string> => {
    const { data, error } = await supabase.storage
      .from("creative_uploads")
      .createSignedUrl(path, 3600);

    if (error) {
      throw new ApiError(error.message, "private_url_error");
    }

    return data.signedUrl;
  },

  downloadPrivateCreative: async (path: string): Promise<Blob> => {
    const { data, error } = await supabase.storage
      .from("creative_uploads")
      .download(path);

    if (error) {
      throw new ApiError(error.message, "private_download_error");
    }

    return data;
  },

  // ==========================================================
  // CREATIVE SUBMISSION
  // ==========================================================

  submitCreativeToBricks: (
    brickIds: number[],
    storagePath: string,
    metadata: CreativeSubmissionMetadata,
  ): Promise<string> => {
    const category = metadata.category.trim();
    const intendedAudience = metadata.intendedAudience.trim();
    const destinationUrl = metadata.destinationUrl.trim();

    if (brickIds.length === 0) {
      throw new ApiError("Select at least one Brick.", "empty_brick_selection");
    }

    if (!category || !intendedAudience || !destinationUrl) {
      throw new ApiError(
        "Complete all creative details before submitting.",
        "missing_creative_metadata",
      );
    }

    let parsedUrl: URL;

    try {
      parsedUrl = new URL(destinationUrl);
    } catch {
      throw new ApiError(
        "Enter a valid destination URL.",
        "invalid_destination_url",
      );
    }

    if (
      parsedUrl.protocol !== "https:" ||
      !parsedUrl.hostname ||
      parsedUrl.username ||
      parsedUrl.password
    ) {
      throw new ApiError(
        "Enter a valid HTTPS destination URL.",
        "invalid_destination_url",
      );
    }

    return handleRpc<string>(
      rpcWithArgs("submit_creative_to_bricks", {
        p_brick_ids: brickIds,
        p_upload_storage_path: storagePath,
        p_category: category,
        p_intended_audience: intendedAudience,
        p_destination_url: parsedUrl.toString(),
      }),
    );
  },

  // ==========================================================
  // CREATIVE MODERATION EDGE FUNCTION
  // ==========================================================

  getPendingCreatives: async (): Promise<PendingCreative[]> => {
    const response = await invokeCreativeModeration<CreativeModerationResponse>(
      {
        action: "list",
      },
    );

    if (!Array.isArray(response.creatives)) {
      throw new ApiError(
        "The moderation service returned an invalid queue.",
        "invalid_moderation_queue",
      );
    }

    return response.creatives;
  },

  adminApproveCreative: async (creativeId: string): Promise<void> => {
    await invokeCreativeModeration<CreativeModerationResponse>({
      action: "approve",
      creativeId,
    });
  },

  adminRejectCreative: async (creativeId: string): Promise<void> => {
    await invokeCreativeModeration<CreativeModerationResponse>({
      action: "reject",
      creativeId,
    });
  },

  isCurrentUserAdmin: async (): Promise<boolean> =>
    handleRpc<boolean>(rpcWithArgs("is_current_user_admin")),

  // ==========================================================
  // PUBLIC WALL
  // ==========================================================

  getOverviewUrl: () => getPublicUrl("wall/overview.webp"),

  getPublicBasePrice: () =>
    handleRpc<number>(rpcWithArgs("get_public_base_price")),

  getPublicWallChunk: async (
    minX: number,
    maxX: number,
    minY: number,
    maxY: number,
  ) => {
    const data = await handleRpc<WallChunkRpcResponse[]>(
      rpcWithArgs("get_public_wall_chunk", {
        p_min_x: minX,
        p_max_x: maxX,
        p_min_y: minY,
        p_max_y: maxY,
      }),
    );

    return data.map((brick) => ({
      ...brick,
      public_image_url: getPublicUrl(brick.public_image_url),
    }));
  },

  // ==========================================================
  // MANAGE TERRITORY
  // ==========================================================

  getMyPlots: async (): Promise<ManagedPlot[]> => {
    const data = await handleRpc<DbPlotRow[]>(rpcWithArgs("get_my_plots"));

    return data.map((plot) => ({
      plotKey: plot.plot_key,
      brickCount: plot.brick_count,
      minX: plot.min_x,
      maxX: plot.max_x,
      minY: plot.min_y,
      maxY: plot.max_y,
      width: plot.max_x - plot.min_x + 1,
      height: plot.max_y - plot.min_y + 1,
      brickIds: plot.brick_ids,
      hasActiveCreative: plot.has_active_creative,
      hasPendingCreative: plot.has_pending_creative,
    }));
  },

  /**
   * Restores creatives currently assigned to the requested Plot Bricks.
   * Pending creatives use private signed URLs; approved creatives use public URLs.
   */
  getMyAssignedCreatives: async (
    brickIds: number[],
  ): Promise<ManagedCreative[]> => {
    if (brickIds.length === 0) {
      return [];
    }

    const rows = await handleRpc<DbManagedCreativeRow[]>(
      rpcWithArgs("get_my_assigned_creatives", {
        p_brick_ids: brickIds,
      }),
    );

    // Sign only non-approved uploads, keeping pending images private.
    const privatePaths = [
      ...new Set(
        rows
          .filter(
            (row) =>
              row.creative_status !== "approved" &&
              Boolean(row.upload_storage_path),
          )
          .map((row) => row.upload_storage_path),
      ),
    ];

    const signedUrls = new Map<string, string>();

    // Keep storage requests bounded for larger territories.
    for (let offset = 0; offset < privatePaths.length; offset += 100) {
      const pathBatch = privatePaths.slice(offset, offset + 100);

      try {
        const { data, error } = await supabase.storage
          .from("creative_uploads")
          .createSignedUrls(pathBatch, 3600);

        if (!error) {
          for (const item of data ?? []) {
            if (item.path && item.signedUrl) {
              signedUrls.set(item.path, item.signedUrl);
            }
          }
        }
      } catch {
        // Preserve saved placement/details if a preview URL cannot be signed.
      }
    }

    return rows.map((row) => ({
      id: row.creative_id,
      status: row.creative_status,
      uploadStoragePath: row.upload_storage_path,
      publicStoragePath: row.public_storage_path,
      createdAt: row.created_at,
      category: row.category,
      intendedAudience: row.intended_audience,
      destinationUrl: row.destination_url,
      brickIds: row.brick_ids,
      previewUrl:
        row.creative_status === "approved"
          ? getPublicUrl(row.public_storage_path)
          : (signedUrls.get(row.upload_storage_path) ?? null),
    }));
  },

  getMyPrivateProfile: () =>
    handleRpc<PrivateProfile>(rpcWithArgs("get_my_private_profile")),

  // ==========================================================
  // BRICK OWNERSHIP AND SECONDARY LISTINGS
  // ==========================================================

  reserveBricks: (brickIds: number[]) =>
    handleRpc<void>(
      rpcWithArgs("reserve_bricks", {
        p_brick_ids: brickIds,
      }),
    ),

  createSecondaryListing: (brickIds: number[], askingPricePaise: number) =>
    handleRpc<void>(
      rpcWithArgs("create_secondary_listing", {
        p_brick_ids: brickIds,
        p_total_asking_price: askingPricePaise,
      }),
    ),

  cancelSecondaryListing: (listingId: string) =>
    handleRpc<void>(
      rpcWithArgs("cancel_secondary_listing", {
        p_listing_id: listingId,
      }),
    ),

  // ==========================================================
  // PAYMENT API
  // ==========================================================

  createRazorpayOrder: async (
    brickIds: number[],
  ): Promise<RazorpayOrderResponse> => {
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session) {
      throw new ApiError("Not authenticated.", "unauthorized");
    }

    const res = await fetch(
      `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/razorpay-checkout?action=create_order`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          payload: { brickIds },
        }),
      },
    );

    const data = await handleFetchResponse(res);

    const intentId = readString(data.intentId);
    const orderId = readString(data.orderId);
    const key = readString(data.key);
    const amount = data.amount;

    if (
      !intentId ||
      !orderId ||
      !key ||
      typeof amount !== "number" ||
      !Number.isSafeInteger(amount) ||
      amount <= 0
    ) {
      throw new ApiError(
        "The payment service returned an invalid order response.",
        "invalid_order_response",
      );
    }

    return { intentId, orderId, amount, key };
  },

  verifyRazorpayPayment: async (payload: {
    walcay_intent_id: string;
    razorpay_payment_id: string;
    razorpay_signature: string;
  }): Promise<PaymentVerificationResult> => {
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session) {
      throw new ApiError("Not authenticated.", "unauthorized");
    }

    const res = await fetch(
      `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/razorpay-checkout?action=verify_payment`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ payload }),
      },
    );

    const data = await readJson(res);

    if (!res.ok) {
      if (
        res.status === 409 &&
        (data.orphaned === true || data.status === "failed_requires_refund")
      ) {
        return {
          success: false,
          status: "failed_requires_refund",
          orphaned: true,
          message: readString(data.message),
          intent_id: readString(data.intent_id),
        };
      }

      throw new ApiError(
        readString(data.message) ??
          readString(data.error) ??
          `Verification failed (${res.status}).`,
        readString(data.error) ?? "verification_failed",
      );
    }

    if (typeof data.success !== "boolean" || typeof data.status !== "string") {
      throw new ApiError(
        "The payment verification response is invalid.",
        "invalid_verification_response",
      );
    }

    return {
      success: data.success,
      status: data.status,
      orphaned: data.orphaned === true ? true : undefined,
      message: readString(data.message),
      intent_id: readString(data.intent_id),
    };
  },

  getPaymentStatus: async (
    walcayIntentId: string,
  ): Promise<PaymentStatusResult> => {
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session) {
      throw new ApiError("Not authenticated.", "unauthorized");
    }

    const res = await fetch(
      `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/razorpay-checkout?action=get_payment_status`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          payload: {
            walcay_intent_id: walcayIntentId,
          },
        }),
      },
    );

    const data = await handleFetchResponse(res);

    if (typeof data.status !== "string") {
      throw new ApiError(
        "The payment status response is invalid.",
        "invalid_status_response",
      );
    }

    return {
      status: data.status,
      failure_reason:
        typeof data.failure_reason === "string" ? data.failure_reason : null,
    };
  },
};
