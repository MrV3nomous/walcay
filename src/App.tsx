import { useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { api } from "./lib/api";
import { supabase } from "./lib/supabase";
import { Admin } from "./pages/Admin";
import { Auth } from "./pages/Auth";
import Manage from "./pages/Manage";
import { Purchase } from "./pages/Purchase";
import Wall from "./pages/Wall";
import { useAppStore } from "./store/appStore";

export default function App() {
  const { session, setSession, setIsAdmin } = useAppStore();
  const [isInitializing, setIsInitializing] = useState(true);

  useEffect(() => {
    let mounted = true;
    const fetchAuth = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!mounted) return;

      setSession(session);

      if (session) {
        try {
          const isAdminStatus = await api.isCurrentUserAdmin();
          setIsAdmin(isAdminStatus);
        } catch {
          setIsAdmin(false);
        }
      } else {
        setIsAdmin(false);
      }
      setIsInitializing(false);
    };

    fetchAuth();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      if (!session) setIsAdmin(false);
      else fetchAuth();
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, [setSession, setIsAdmin]);

  if (isInitializing) return <div className="w-screen h-screen bg-[#050505]" />;

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Wall />} />
        <Route path="/auth" element={<Auth />} />
        <Route path="/purchase" element={<Purchase />} />
        <Route path="/admin" element={<Admin />} />
        <Route
          path="/manage"
          element={session ? <Manage /> : <Navigate to="/auth" replace />}
        />
      </Routes>
    </BrowserRouter>
  );
}
