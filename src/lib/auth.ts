import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";

export const auth = {
  getSession: async () => {
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    return data.session;
  },
  onAuthStateChange: (
    callback: (event: string, session: Session | null) => void,
  ) => {
    return supabase.auth.onAuthStateChange(callback);
  },
  signInWithEmail: async (email: string, password: string) => {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) throw error;
    return data;
  },
  signUpWithEmail: async (email: string, password: string) => {
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) throw error;
    return data;
  },
  signOut: async () => {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
  },
};
