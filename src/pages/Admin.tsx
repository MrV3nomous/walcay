import { useCallback, useEffect, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { type PendingCreative, api } from "../lib/api";
import { useAppStore } from "../store/appStore";

type ModerationAction = "approve" | "reject";

interface ConfirmationRequest {
  item: PendingCreative;
  action: ModerationAction;
}

function QueueItem({
  item,
  busy,
  onRequestAction,
}: {
  item: PendingCreative;
  busy: boolean;
  onRequestAction: (item: PendingCreative, action: ModerationAction) => void;
}) {
  return (
    <article className="rounded-xl border border-neutral-800 bg-[#0b0b0b] p-4 sm:p-5">
      <div className="flex flex-col gap-4 sm:flex-row">
        <div className="flex h-40 w-full shrink-0 items-center justify-center overflow-hidden rounded-lg border border-neutral-800 bg-[#050505] sm:h-32 sm:w-32">
          {item.preview_url ? (
            <img
              src={item.preview_url}
              alt="Pending creative preview"
              referrerPolicy="no-referrer"
              className="h-full w-full object-contain"
            />
          ) : (
            <span className="px-3 text-center text-xs text-neutral-500">
              Preview unavailable
            </span>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <p className="break-all font-mono text-xs text-neutral-500">
            {item.id}
          </p>

          <p className="mt-2 text-sm text-neutral-300">
            Owner:{" "}
            <span className="break-all font-mono text-neutral-500">
              {item.owner_id}
            </span>
          </p>

          <p className="mt-1 text-xs text-neutral-500">
            {new Date(item.created_at).toLocaleString()}
          </p>

          <dl className="mt-4 space-y-2 text-sm">
            <div>
              <dt className="inline text-neutral-500">Category: </dt>
              <dd className="inline text-neutral-200">
                {item.category || "Not supplied"}
              </dd>
            </div>

            <div>
              <dt className="inline text-neutral-500">Intended audience: </dt>
              <dd className="inline text-neutral-200">
                {item.intended_audience || "Not supplied"}
              </dd>
            </div>

            <div className="min-w-0">
              <dt className="inline text-neutral-500">Destination: </dt>
              {item.destination_url ? (
                <a
                  href={item.destination_url}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="break-all text-neutral-200 underline underline-offset-4 hover:text-white"
                >
                  {item.destination_url}
                </a>
              ) : (
                <dd className="inline text-neutral-500">Not supplied</dd>
              )}
            </div>
          </dl>

          <div className="mt-5 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => onRequestAction(item, "approve")}
              disabled={busy || !item.preview_url}
              className="rounded-lg bg-white px-4 py-2.5 text-sm font-medium text-black transition-colors hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Approve & publish
            </button>

            <button
              type="button"
              onClick={() => onRequestAction(item, "reject")}
              disabled={busy}
              className="rounded-lg border border-neutral-800 px-4 py-2.5 text-sm text-neutral-300 transition-colors hover:bg-neutral-900 disabled:opacity-40"
            >
              Reject
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}

export function Admin() {
  const { session, isAdmin } = useAppStore();

  const [pending, setPending] = useState<PendingCreative[]>([]);
  const [isLoadingQueue, setIsLoadingQueue] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(
    null,
  );
  const [busyCreativeId, setBusyCreativeId] = useState<string | null>(null);

  const loadQueue = useCallback(async () => {
    setIsLoadingQueue(true);
    setQueueError(null);

    try {
      const data = await api.getPendingCreatives();
      setPending(data);
    } catch (error) {
      setQueueError(
        error instanceof Error
          ? error.message
          : "Unable to load the moderation queue.",
      );
    } finally {
      setIsLoadingQueue(false);
    }
  }, []);

  useEffect(() => {
    if (isAdmin) {
      void loadQueue();
    }
  }, [isAdmin, loadQueue]);

  const performConfirmedAction = async () => {
    if (!confirmation) return;

    const action = confirmation.action;
    const item = confirmation.item;

    setConfirmation(null);
    setBusyCreativeId(item.id);
    setNotice(null);

    try {
      if (action === "approve") {
        await api.adminApproveCreative(item.id);
      } else {
        await api.adminRejectCreative(item.id);
      }

      setNotice({
        type: "success",
        message:
          action === "approve"
            ? "Creative approved and published."
            : "Creative rejected. Any existing active creative remains unchanged.",
      });

      await loadQueue();
    } catch (error) {
      setNotice({
        type: "error",
        message:
          error instanceof Error
            ? error.message
            : `Unable to ${action} this creative.`,
      });
    } finally {
      setBusyCreativeId(null);
    }
  };

  if (!session) {
    return <Navigate to="/auth" replace />;
  }

  if (!isAdmin) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="min-h-screen bg-[#080808] px-5 py-8 text-neutral-200 sm:px-8 md:py-12">
      <div className="mx-auto max-w-5xl">
        <header className="mb-8 flex flex-col justify-between gap-5 border-b border-neutral-800 pb-7 sm:flex-row sm:items-end">
          <div>
            <p className="text-xs tracking-wide text-neutral-500">
              WALCAY / OPERATIONS
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white">
              Moderation
            </h1>
            <p className="mt-2 text-sm text-neutral-500">
              Review submitted artwork before it appears on the Wall.
            </p>
          </div>

          <Link
            to="/"
            className="self-start rounded-lg border border-neutral-800 px-4 py-2.5 text-sm text-neutral-300 transition-colors hover:bg-neutral-900 sm:self-auto"
          >
            Return to Wall
          </Link>
        </header>

        {notice && (
          <div
            role={notice.type === "error" ? "alert" : "status"}
            className="mb-6 rounded-lg border border-neutral-800 bg-[#0d0d0d] px-4 py-3 text-sm text-neutral-300"
          >
            <div className="flex items-start justify-between gap-4">
              <p>{notice.message}</p>
              <button
                type="button"
                aria-label="Dismiss message"
                onClick={() => setNotice(null)}
                className="shrink-0 text-neutral-500 hover:text-white"
              >
                ×
              </button>
            </div>
          </div>
        )}

        <section>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-medium text-white">
              Pending creatives{" "}
              <span className="ml-1 text-neutral-500">{pending.length}</span>
            </h2>

            <button
              type="button"
              onClick={() => void loadQueue()}
              disabled={isLoadingQueue || busyCreativeId !== null}
              className="rounded-lg border border-neutral-800 px-3 py-2 text-sm text-neutral-300 transition-colors hover:bg-neutral-900 disabled:opacity-40"
            >
              {isLoadingQueue ? "Refreshing…" : "Refresh"}
            </button>
          </div>

          {queueError && (
            <div
              role="alert"
              className="mb-4 rounded-lg border border-neutral-800 bg-[#0d0d0d] p-4 text-sm text-neutral-300"
            >
              Unable to load the moderation queue: {queueError}
            </div>
          )}

          {isLoadingQueue && pending.length === 0 ? (
            <div className="rounded-xl border border-neutral-800 py-16 text-center text-sm text-neutral-500">
              Loading submissions…
            </div>
          ) : pending.length > 0 ? (
            <div className="space-y-3">
              {pending.map((item) => (
                <QueueItem
                  key={item.id}
                  item={item}
                  busy={busyCreativeId !== null}
                  onRequestAction={(creative, action) => {
                    setConfirmation({ item: creative, action });
                  }}
                />
              ))}
            </div>
          ) : !queueError ? (
            <div className="rounded-xl border border-neutral-800 py-16 text-center">
              <p className="text-sm text-neutral-300">
                The moderation queue is empty.
              </p>
              <p className="mt-2 text-xs text-neutral-500">
                New submissions will appear here.
              </p>
            </div>
          ) : null}
        </section>
      </div>

      {confirmation && (
        <dialog
          open
          aria-modal="true"
          aria-labelledby="moderation-confirm-title"
          className="fixed inset-0 z-[100] m-0 flex h-full w-full max-w-none items-center justify-center border-0 bg-black/75 p-4 text-white backdrop:bg-black/75"
        >
          <div className="w-full max-w-md rounded-xl border border-neutral-700 bg-[#101010] p-6 shadow-2xl">
            <h3 id="moderation-confirm-title" className="text-lg font-medium">
              {confirmation.action === "approve"
                ? "Approve and publish?"
                : "Reject this creative?"}
            </h3>

            <p className="mt-3 text-sm leading-relaxed text-neutral-400">
              {confirmation.action === "approve"
                ? "The image will be validated, published to public storage, and activated on its assigned Bricks."
                : "The pending submission will be rejected. An existing active creative will not be removed."}
            </p>

            <p className="mt-3 break-all font-mono text-xs text-neutral-500">
              {confirmation.item.id}
            </p>

            <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => setConfirmation(null)}
                className="rounded-lg border border-neutral-800 px-4 py-2.5 text-sm text-neutral-300 hover:bg-neutral-900"
              >
                Cancel
              </button>

              <button
                type="button"
                onClick={() => void performConfirmedAction()}
                className="rounded-lg bg-white px-4 py-2.5 text-sm font-medium text-black hover:bg-neutral-200"
              >
                {confirmation.action === "approve"
                  ? "Approve & publish"
                  : "Confirm rejection"}
              </button>
            </div>
          </div>
        </dialog>
      )}
    </div>
  );
}