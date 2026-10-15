import type { Session, User } from "@supabase/supabase-js";
import { create } from "zustand";
import type { WallChunkRpcResponse } from "../lib/api";

export type InteractionMode = "explore" | "select";

interface AppState {
  session: Session | null;
  user: User | null;
  isInitialized: boolean;
  setSession: (session: Session | null) => void;
  setInitialized: (status: boolean) => void;

  isAdmin: boolean;
  setIsAdmin: (isAdmin: boolean) => void;

  interactionMode: InteractionMode;
  setInteractionMode: (mode: InteractionMode) => void;

  basePricePaise: number | null;
  setBasePricePaise: (price: number | null) => void;

  selectedBrickIds: Set<number>;
  toggleBrickSelection: (id: number) => void;
  addBrickSelections: (ids: number[]) => void;
  removeBrickSelection: (id: number) => void;
  removeBrickSelections: (ids: number[]) => void;
  clearSelection: () => void;

  activeBrick: WallChunkRpcResponse | null;
  setActiveBrick: (brick: WallChunkRpcResponse | null) => void;
  isProfileOpen: boolean;
  setProfileOpen: (isOpen: boolean) => void;

  isLoadingChunks: boolean;
  setLoadingChunks: (loading: boolean) => void;
  chunkError: string | null;
  setChunkError: (error: string | null) => void;
}

const MAX_ACQUISITION_BRICKS = 10000;

export const useAppStore = create<AppState>((set) => ({
  session: null,
  user: null,
  isInitialized: false,
  setSession: (session) => set({ session, user: session?.user ?? null }),
  setInitialized: (status) => set({ isInitialized: status }),

  isAdmin: false,
  setIsAdmin: (isAdmin) => set({ isAdmin }),

  interactionMode: "explore",
  setInteractionMode: (mode) => set({ interactionMode: mode }),

  basePricePaise: null,
  setBasePricePaise: (price) => set({ basePricePaise: price }),

  selectedBrickIds: new Set(),
  toggleBrickSelection: (id) =>
    set((state) => {
      const next = new Set(state.selectedBrickIds);
      if (next.has(id)) {
        next.delete(id);
      } else if (next.size < MAX_ACQUISITION_BRICKS) {
        next.add(id);
      }
      return { selectedBrickIds: next };
    }),

  addBrickSelections: (ids) =>
    set((state) => {
      const next = new Set(state.selectedBrickIds);
      for (const id of ids) {
        if (next.size >= MAX_ACQUISITION_BRICKS) break;
        next.add(id);
      }
      return { selectedBrickIds: next };
    }),

  removeBrickSelection: (id) =>
    set((state) => {
      const next = new Set(state.selectedBrickIds);
      if (next.has(id)) {
        next.delete(id);
        return { selectedBrickIds: next };
      }
      return state;
    }),

  removeBrickSelections: (ids) =>
    set((state) => {
      const next = new Set(state.selectedBrickIds);
      let changed = false;
      for (const id of ids) {
        if (next.delete(id)) changed = true;
      }
      return changed ? { selectedBrickIds: next } : state;
    }),

  clearSelection: () => set({ selectedBrickIds: new Set() }),

  activeBrick: null,
  setActiveBrick: (brick) => set({ activeBrick: brick }),
  isProfileOpen: false,
  setProfileOpen: (isOpen) =>
    set((state) => ({
      isProfileOpen: isOpen,
      activeBrick: isOpen ? null : state.activeBrick,
    })),

  isLoadingChunks: false,
  setLoadingChunks: (loading) => set({ isLoadingChunks: loading }),
  chunkError: null,
  setChunkError: (error) => set({ chunkError: error }),
}));
