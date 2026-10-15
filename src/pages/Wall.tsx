import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { WallCanvas } from "../components/WallCanvas";
import { api } from "../lib/api";
import { auth } from "../lib/auth";
import { useAppStore } from "../store/appStore";

export default function Wall() {
  const navigate = useNavigate();
  const [isHelpOpen, setHelpOpen] = useState(false);

  const {
    session,
    isAdmin,
    interactionMode,
    setInteractionMode,
    basePricePaise,
    setBasePricePaise,
    selectedBrickIds,
    clearSelection,
    isLoadingChunks,
    chunkError,
    setChunkError,
    setLoadingChunks,
    activeBrick,
    setActiveBrick,
    isProfileOpen,
    setProfileOpen,
  } = useAppStore();

  useEffect(() => {
    api
      .getPublicBasePrice()
      .then((price) => setBasePricePaise(price as number))
      .catch(console.error);

    return () => {
      setChunkError(null);
      setLoadingChunks(false);
      setActiveBrick(null);
      setProfileOpen(false);
    };
  }, [
    setBasePricePaise,
    setChunkError,
    setLoadingChunks,
    setActiveBrick,
    setProfileOpen,
  ]);

  useEffect(() => {
    if (activeBrick) setHelpOpen(false);
  }, [activeBrick]);

  const selectedCount = selectedBrickIds.size;
  const totalPrice = basePricePaise
    ? (selectedCount * basePricePaise) / 100
    : 0;

  return (
    <div className="relative w-full h-full bg-neutral-950 overflow-hidden select-none">
      <WallCanvas />

      {/* TOP LEFT: Brand */}
      <div className="absolute top-4 left-4 md:top-6 md:left-6 z-10 pointer-events-none">
        <div className="pointer-events-auto bg-neutral-950/80 backdrop-blur-md px-4 py-2 rounded-lg border border-neutral-800/50">
          <h1 className="text-xl md:text-2xl font-bold tracking-widest text-white leading-none">
            WALCAY
          </h1>
        </div>
      </div>

      {/* TOP CENTER: Mode Toggle Pill */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10 pointer-events-none">
        <div className="pointer-events-auto bg-neutral-900/90 backdrop-blur-md p-1.5 rounded-full border border-neutral-800 flex items-center shadow-2xl">
          <button
            type="button"
            onClick={() => {
              setInteractionMode("explore");
              setActiveBrick(null);
            }}
            className={`px-6 py-2 rounded-full text-sm font-bold transition-all duration-200 flex items-center gap-2 ${
              interactionMode === "explore"
                ? "bg-neutral-700 text-white shadow-md"
                : "text-neutral-500 hover:text-neutral-300"
            }`}
          >
            Explore
          </button>

          <button
            type="button"
            onClick={() => {
              setInteractionMode("select");
              setActiveBrick(null);
            }}
            className={`px-6 py-2 rounded-full text-sm font-bold transition-all duration-200 flex items-center gap-2 ${
              interactionMode === "select"
                ? "bg-white text-black shadow-md"
                : "text-neutral-500 hover:text-neutral-300"
            }`}
          >
            Select Bricks
          </button>
        </div>
      </div>

      {/* TOP RIGHT: Controls */}
      <div className="absolute top-4 right-4 md:top-6 md:right-6 z-10 pointer-events-none flex gap-3">
        {isAdmin && (
          <Link
            to="/admin"
            className="pointer-events-auto bg-[#171717] hover:bg-[#262626] border border-neutral-800 px-4 py-2 rounded-lg text-sm font-semibold transition-colors shadow-xl"
          >
            Admin
          </Link>
        )}
        <button
          type="button"
          onClick={() => {
            setHelpOpen(!isHelpOpen);
            if (!isHelpOpen) {
              setProfileOpen(false);
              setActiveBrick(null);
            }
          }}
          className="pointer-events-auto bg-neutral-950/80 backdrop-blur-md px-4 py-2 rounded-lg border border-neutral-800/50 text-white text-sm font-semibold hover:bg-neutral-900 transition-colors"
        >
          Help
        </button>
        <button
          type="button"
          onClick={() => {
            setProfileOpen(!isProfileOpen);
            if (!isProfileOpen) {
              setHelpOpen(false);
              setActiveBrick(null);
            }
          }}
          className="pointer-events-auto bg-neutral-950/80 backdrop-blur-md px-4 py-2 rounded-lg border border-neutral-800/50 text-white text-sm font-semibold hover:bg-neutral-900 transition-colors"
        >
          {session ? "Account" : "Sign In"}
        </button>
      </div>

      {/* HELP OVERLAY */}
      {isHelpOpen && (
        <div className="absolute top-16 right-4 md:top-20 md:right-6 z-20 pointer-events-none w-full max-w-[280px] px-4 md:px-0">
          <div className="pointer-events-auto bg-neutral-950/95 border border-neutral-800 p-5 rounded-xl shadow-2xl backdrop-blur-xl flex flex-col gap-4">
            <div className="flex justify-between items-center mb-2">
              <h2 className="text-white text-xs uppercase tracking-widest font-bold">
                Help
              </h2>
              <button
                type="button"
                onClick={() => setHelpOpen(false)}
                className="text-neutral-500 hover:text-white transition-colors"
              >
                ✕
              </button>
            </div>
            <div className="text-sm text-neutral-300 flex flex-col gap-3">
              <p className="font-semibold text-white">How to use THE WALL</p>
              <p>
                • <b>Explore Mode:</b> Drag to pan around. Click any Brick to
                see its owner and artwork.
              </p>
              <p>
                • <b>Select Mode:</b> Click to select individual Bricks, or Drag
                a box to select multiple Bricks (Up to 100×100).
              </p>
              <div className="h-px bg-neutral-800/50 w-full my-1" />
              <p className="text-xs text-neutral-400">
                <b>Tip:</b> Hold{" "}
                <kbd className="bg-neutral-800 px-1 rounded">Shift</kbd> while
                dragging to deselect Bricks. Hold{" "}
                <kbd className="bg-neutral-800 px-1 rounded">Spacebar</kbd> to
                pan while in Select mode.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* PROFILE OVERLAY */}
      {isProfileOpen && (
        <div className="absolute top-16 right-4 md:top-20 md:right-6 z-20 pointer-events-none w-full max-w-[280px] px-4 md:px-0">
          <div className="pointer-events-auto bg-neutral-950/95 border border-neutral-800 p-5 rounded-xl shadow-2xl backdrop-blur-xl flex flex-col gap-4">
            <div className="flex justify-between items-center mb-2">
              <h2 className="text-white text-xs uppercase tracking-widest font-bold">
                Account
              </h2>
              <button
                type="button"
                onClick={() => setProfileOpen(false)}
                className="text-neutral-500 hover:text-white transition-colors"
              >
                ✕
              </button>
            </div>

            {session ? (
              <>
                <div className="text-sm text-neutral-400 truncate">
                  {session.user.email}
                </div>
                <div className="h-px bg-neutral-800/50 w-full my-1" />
                <button
                  type="button"
                  onClick={() => navigate("/manage")}
                  className="text-left text-white text-sm font-semibold hover:text-amber-500 transition-colors"
                >
                  Manage Territory
                </button>
                <button
                  type="button"
                  onClick={() => {
                    auth.signOut();
                    setProfileOpen(false);
                  }}
                  className="text-left text-neutral-500 text-sm font-medium hover:text-white transition-colors"
                >
                  Sign Out
                </button>
              </>
            ) : (
              <>
                <div className="text-sm text-neutral-400">
                  Sign in to manage your acquired territory and creative assets.
                </div>
                <button
                  type="button"
                  onClick={() => navigate("/auth")}
                  className="w-full py-2 bg-white text-black rounded-lg text-sm font-bold mt-2 hover:bg-neutral-200 transition-colors"
                >
                  Sign In
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ACTIVE BRICK DETAIL (SIDE DRAWER/PANEL) */}
      {activeBrick && !isProfileOpen && !isHelpOpen && (
        <div className="absolute top-20 right-4 md:top-24 md:right-6 z-10 pointer-events-none w-full max-w-[320px] px-4 md:px-0">
          <div className="pointer-events-auto bg-neutral-950/95 border border-neutral-800 p-5 rounded-xl shadow-2xl backdrop-blur-xl">
            <div className="flex justify-between items-start mb-4">
              <div>
                <h2 className="text-white font-bold text-lg leading-none mb-1">
                  Brick #{activeBrick.id}
                </h2>
                <div className="text-xs text-neutral-500 font-medium tracking-wide">
                  Coordinates: {activeBrick.x}, {activeBrick.y}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setActiveBrick(null)}
                className="text-neutral-500 hover:text-white transition-colors"
              >
                ✕
              </button>
            </div>

            {activeBrick.public_image_url && (
              <img
                src={activeBrick.public_image_url}
                alt="Brick Creative"
                className="w-full aspect-square object-cover rounded-lg mb-5 border border-neutral-800/50 bg-neutral-900"
              />
            )}

            {activeBrick.is_listed ? (
              <div className="mb-5">
                <span className="inline-block bg-amber-500/10 text-amber-500 border border-amber-500/20 px-2 py-1 rounded text-xs font-bold tracking-widest uppercase mb-2">
                  For Sale
                </span>
              </div>
            ) : activeBrick.is_owned ? (
              <div className="mb-5">
                <div className="text-xs text-neutral-500 uppercase tracking-widest font-semibold mb-1">
                  Owner
                </div>
                <div className="text-white text-sm">
                  {activeBrick.owner_name || "Anonymous"}
                </div>
              </div>
            ) : (
              <div className="mb-5">
                <span className="inline-block bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2.5 py-1 rounded text-xs font-bold tracking-wider uppercase mb-2">
                  Available
                </span>
                <p className="text-xs text-neutral-400 mt-1">
                  This brick is unowned. Switch to <b>Select Bricks</b> mode to
                  acquire it.
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* SELECTION BAR */}
      {selectedCount > 0 && (
        <div className="absolute bottom-4 md:bottom-8 left-1/2 -translate-x-1/2 z-10 pointer-events-none w-full max-w-md px-4">
          <div className="pointer-events-auto bg-neutral-950/95 border border-neutral-800 p-4 md:p-5 rounded-xl shadow-2xl backdrop-blur-xl flex flex-col gap-4">
            <div className="flex justify-between items-center">
              <div>
                <span className="text-white font-bold text-xl">
                  {selectedCount.toLocaleString()}
                </span>
                <span className="text-neutral-500 font-medium text-sm ml-2">
                  / 10,000 Bricks
                </span>
              </div>
              <div className="text-right">
                <span className="text-white font-bold text-xl">
                  ₹
                  {totalPrice.toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </span>
              </div>
            </div>

            {selectedCount >= 10000 && (
              <div className="text-xs text-amber-500 font-medium text-center bg-amber-500/10 py-1.5 rounded border border-amber-500/20">
                Maximum territory selection reached (10,000 Bricks)
              </div>
            )}

            <div className="flex gap-2">
              <button
                type="button"
                onClick={clearSelection}
                className="flex-1 py-2.5 bg-neutral-900 hover:bg-neutral-800 text-neutral-300 rounded-lg text-sm font-semibold transition-colors border border-neutral-800"
              >
                Clear
              </button>
              <button
                type="button"
                onClick={() => navigate("/purchase")}
                className="flex-1 py-2.5 bg-white text-black hover:bg-neutral-200 rounded-lg text-sm font-bold transition-colors"
              >
                Acquire
              </button>
            </div>
          </div>
        </div>
      )}

      {/* NETWORK / ERROR TOAST */}
      <div className="absolute bottom-4 right-4 flex flex-col gap-2 items-end z-10 pointer-events-none">
        {chunkError && (
          <div className="bg-red-950/90 text-red-400 text-xs px-3 py-2 rounded-lg border border-red-900/50 backdrop-blur-md shadow-lg pointer-events-auto">
            {chunkError}
          </div>
        )}
        {isLoadingChunks && (
          <div className="bg-neutral-900/90 text-neutral-400 text-xs px-3 py-2 rounded-lg border border-neutral-800/50 backdrop-blur-md shadow-lg flex items-center gap-2">
            <div className="w-1.5 h-1.5 bg-amber-500 rounded-full animate-pulse" />
            Syncing territory...
          </div>
        )}
      </div>
    </div>
  );
}
