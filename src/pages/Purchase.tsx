import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { ApiError, api } from "../lib/api";
import { useAppStore } from "../store/appStore";

interface RazorpayResponse {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

interface RazorpayErrorResponse {
  error?: {
    description?: string;
    code?: string;
    reason?: string;
  };
}

interface RazorpayOptions {
  key: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  order_id: string;
  handler: (response: RazorpayResponse) => void | Promise<void>;
  theme: { color: string };
  modal: { ondismiss: () => void };
}

declare global {
  interface Window {
    Razorpay: new (
      options: RazorpayOptions,
    ) => {
      open: () => void;
      on: (
        event: string,
        handler: (response: RazorpayErrorResponse) => void,
      ) => void;
    };
  }
}

const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 10;

export function Purchase() {
  const navigate = useNavigate();
  const { session, selectedBrickIds, clearSelection, basePricePaise } =
    useAppStore();

  const [loadingStep, setLoadingStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successCount, setSuccessCount] = useState<number | null>(null);
  const [isRazorpayLoaded, setIsRazorpayLoaded] = useState(
    () =>
      typeof window !== "undefined" && typeof window.Razorpay === "function",
  );
  const [isPolling, setIsPolling] = useState(false);
  const [backendAmount, setBackendAmount] = useState<number | null>(null);

  const pollTimerRef = useRef<number | null>(null);
  const pollRunRef = useRef(0);
  const mountedRef = useRef(false);
  const completedRef = useRef(false);
  const paymentHandlerStartedRef = useRef(false);

  const brickArray = Array.from(selectedBrickIds).sort((a, b) => a - b);
  const priceDisplay =
    basePricePaise !== null
      ? `₹${(basePricePaise / 100).toFixed(2)}`
      : "Loading...";
  const expectedTotalDisplay =
    backendAmount !== null
      ? backendAmount / 100
      : basePricePaise !== null
        ? (basePricePaise * brickArray.length) / 100
        : null;

  useEffect(() => {
    mountedRef.current = true;

    if (typeof window.Razorpay === "function") {
      setIsRazorpayLoaded(true);
      return () => {
        mountedRef.current = false;
        pollRunRef.current += 1;
        if (pollTimerRef.current !== null) {
          window.clearTimeout(pollTimerRef.current);
          pollTimerRef.current = null;
        }
      };
    }

    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.async = true;
    script.onload = () => {
      if (mountedRef.current) setIsRazorpayLoaded(true);
    };
    script.onerror = () => {
      if (mountedRef.current) {
        setError(
          "Failed to load the payment gateway. Please refresh and try again.",
        );
      }
    };
    document.body.appendChild(script);

    return () => {
      mountedRef.current = false;
      pollRunRef.current += 1;
      if (pollTimerRef.current !== null) {
        window.clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      if (document.body.contains(script)) document.body.removeChild(script);
    };
  }, []);

  const finishPolling = (runId: number) => {
    if (pollRunRef.current !== runId) return;
    pollRunRef.current += 1;
    if (pollTimerRef.current !== null) {
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (mountedRef.current) {
      setIsPolling(false);
      setLoadingStep(null);
    }
  };

  const showPurchaseSuccess = (count: number, runId?: number) => {
    if (runId !== undefined && pollRunRef.current !== runId) return;
    completedRef.current = true;
    if (runId !== undefined) finishPolling(runId);
    setError(null);
    setSuccessCount(count);
    clearSelection();
    setLoadingStep(null);
    setIsPolling(false);
  };

  const pollStatus = (intentId: string, count: number) => {
    // Invalidate any previous polling loop before starting another one.
    pollRunRef.current += 1;
    const runId = pollRunRef.current;

    if (pollTimerRef.current !== null) {
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }

    setError(null);
    setLoadingStep("Payment submitted. Confirming payment and ownership...");
    setIsPolling(true);

    let attempts = 0;

    const poll = async () => {
      if (!mountedRef.current || pollRunRef.current !== runId) return;
      attempts += 1;

      try {
        const statusData = await api.getPaymentStatus(intentId);

        // The component may have unmounted or a newer poll may have started
        // while the request was in flight.
        if (!mountedRef.current || pollRunRef.current !== runId) return;

        if (statusData.status === "paid") {
          showPurchaseSuccess(count, runId);
          return;
        }

        if (statusData.status === "failed_requires_refund") {
          finishPolling(runId);
          setError(
            `Payment was received, but ownership could not be confirmed. ${statusData.failure_reason || "This payment requires manual reconciliation."} Do not pay again for this purchase.`,
          );
          return;
        }
      } catch (pollError) {
        // Keep retrying briefly. A transport/API error is not proof that
        // payment succeeded or failed.
        console.error("[Purchase] Payment status polling failed:", pollError);
      }

      if (attempts >= MAX_POLL_ATTEMPTS) {
        finishPolling(runId);
        setError(
          "We could not confirm the final payment and ownership status. Do not pay again yet. Check the payment status before retrying checkout.",
        );
        return;
      }

      pollTimerRef.current = window.setTimeout(poll, POLL_INTERVAL_MS);
    };

    void poll();
  };

  if (!session) return <Navigate replace to="/auth" />;
  if (brickArray.length === 0 && successCount === null && !isPolling) {
    return <Navigate replace to="/" />;
  }

  const handleCheckout = async () => {
    if (loadingStep || isPolling) return;
    if (!isRazorpayLoaded || typeof window.Razorpay !== "function") {
      setError(
        "The payment gateway is still loading. Please wait and try again.",
      );
      return;
    }
    if (basePricePaise === null) {
      setError("The base price has not loaded yet.");
      return;
    }
    if (brickArray.length === 0) {
      setError("Select at least one Brick before checking out.");
      return;
    }

    setError(null);
    setBackendAmount(null);
    completedRef.current = false;
    paymentHandlerStartedRef.current = false;

    try {
      setLoadingStep("Reserving selected Bricks...");
      await api.reserveBricks(brickArray);

      setLoadingStep("Creating secure payment order...");
      const { intentId, orderId, key, amount } =
        await api.createRazorpayOrder(brickArray);

      if (
        !intentId ||
        !orderId ||
        !key ||
        !Number.isSafeInteger(amount) ||
        amount <= 0
      ) {
        throw new ApiError(
          "The payment order response is incomplete. Please try again.",
          "invalid_order_response",
        );
      }

      setBackendAmount(amount);
      setLoadingStep("Waiting for payment...");

      const options: RazorpayOptions = {
        key,
        amount,
        currency: "INR",
        name: "WALCAY",
        description: `Primary purchase of ${brickArray.length.toLocaleString()} Bricks`,
        order_id: orderId,
        handler: async (response: RazorpayResponse) => {
          paymentHandlerStartedRef.current = true;
          // Do not trust the popup's success callback as allocation proof.
          // The backend verifies the order/payment binding and final DB state.
          if (
            !response?.razorpay_payment_id ||
            !response?.razorpay_signature ||
            response.razorpay_order_id !== orderId
          ) {
            pollStatus(intentId, brickArray.length);
            return;
          }

          try {
            setLoadingStep("Verifying payment and allocating Bricks...");
            const result = await api.verifyRazorpayPayment({
              walcay_intent_id: intentId,
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_signature: response.razorpay_signature,
            });

            if (result.success === true && result.status === "paid") {
              showPurchaseSuccess(brickArray.length);
              return;
            }

            if (
              result.orphaned === true ||
              result.status === "failed_requires_refund"
            ) {
              setLoadingStep(null);
              setError(
                `Payment was received, but ownership could not be confirmed. ${result.message || "Manual reconciliation is required."} Do not pay again for this purchase.`,
              );
              return;
            }

            pollStatus(intentId, brickArray.length);
          } catch (verificationError) {
            // A failed browser verification can race with a valid webhook.
            // Poll the database's authoritative status before deciding.
            console.error(
              "[Purchase] Payment verification failed:",
              verificationError,
            );
            pollStatus(intentId, brickArray.length);
          }
        },
        theme: { color: "#171717" },
        modal: {
          ondismiss: () => {
            if (!completedRef.current && !paymentHandlerStartedRef.current) {
              setLoadingStep(null);
            }
          },
        },
      };

      const razorpay = new window.Razorpay(options);
      razorpay.on("payment.failed", (failure: RazorpayErrorResponse) => {
        paymentHandlerStartedRef.current = true;
        const description = failure?.error?.description;
        setLoadingStep(null);
        setError(
          description
            ? `Razorpay could not complete the payment: ${description}`
            : "Razorpay could not complete the payment. Check payment status before trying again.",
        );
      });

      razorpay.open();
    } catch (checkoutError) {
      console.error(
        "[Purchase] Checkout initialization failed:",
        checkoutError,
      );
      const message =
        checkoutError instanceof Error
          ? checkoutError.message
          : "Checkout initialization failed.";
      const code = checkoutError instanceof ApiError ? checkoutError.code : "";

      if (code === "lease_lost") {
        setError(
          "Your payment session expired or changed. Please refresh the selection and try again.",
        );
      } else {
        setError(message || "Checkout initialization failed.");
      }
      setLoadingStep(null);
    }
  };

  if (successCount !== null) {
    return (
      <div className="w-screen min-h-screen bg-[#050505] text-neutral-200 flex flex-col items-center justify-center p-8">
        <div className="bg-[#0a0a0a] border border-neutral-800 rounded-xl p-8 max-w-md w-full text-center">
          <div className="w-16 h-16 bg-emerald-900/30 text-emerald-400 border border-emerald-900/50 rounded-full flex items-center justify-center mx-auto mb-6 text-2xl font-bold">
            ✓
          </div>
          <h2 className="text-2xl font-bold text-white mb-2">
            Purchase Successful
          </h2>
          <p className="text-neutral-400 mb-8">
            You are now the official owner of {successCount.toLocaleString()}{" "}
            Bricks on THE WALL.
          </p>
          <button
            type="button"
            onClick={() => navigate("/manage")}
            className="inline-block w-full bg-white text-black font-medium py-3 rounded-md hover:bg-neutral-200 transition-colors"
          >
            Manage Territory &amp; Artwork
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="w-screen min-h-screen bg-[#050505] text-neutral-200 p-8 flex flex-col items-center justify-center">
      <Link
        className="absolute top-6 left-6 bg-[#0a0a0a] border border-neutral-800 px-4 py-2 rounded-md"
        to="/"
      >
        <span className="font-bold tracking-widest text-white uppercase">
          Walcay
        </span>
      </Link>

      <div className="w-full max-w-md bg-[#0a0a0a] border border-neutral-800 rounded-xl overflow-hidden shadow-2xl">
        <div className="p-6 border-b border-neutral-800">
          <h1 className="text-xl font-bold text-white">Review Purchase</h1>
        </div>

        <div className="p-6 flex flex-col gap-4">
          {error && (
            <div
              role="alert"
              className="p-3 bg-red-950/50 border border-red-900/50 text-red-400 rounded-md text-sm"
            >
              {error}
            </div>
          )}

          <div className="flex justify-between items-center py-2 border-b border-neutral-800/50">
            <span className="text-neutral-400">Bricks Selected</span>
            <span className="font-mono text-white">
              {brickArray.length.toLocaleString()}
            </span>
          </div>

          <div className="flex justify-between items-center py-2 border-b border-neutral-800/50">
            <span className="text-neutral-400">Authoritative Price</span>
            <span className="font-mono text-white">{priceDisplay}</span>
          </div>

          <div className="flex justify-between items-center py-4 mt-2">
            <span className="text-lg text-white font-medium">
              Expected Total
            </span>
            <span className="text-xl font-mono text-emerald-400">
              {expectedTotalDisplay !== null
                ? `₹${expectedTotalDisplay.toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}`
                : "Loading..."}
            </span>
          </div>

          <button
            type="button"
            onClick={handleCheckout}
            disabled={
              expectedTotalDisplay === null ||
              !!loadingStep ||
              !isRazorpayLoaded ||
              isPolling
            }
            className="w-full mt-4 bg-white text-black font-medium py-3 rounded-md hover:bg-neutral-200 transition-colors disabled:opacity-50 relative"
          >
            {loadingStep ? (
              <span className="animate-pulse">{loadingStep}</span>
            ) : expectedTotalDisplay !== null ? (
              `Pay ₹${expectedTotalDisplay.toLocaleString(undefined, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}`
            ) : (
              "Loading..."
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
