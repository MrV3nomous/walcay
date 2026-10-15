import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../lib/api";

export function Auth() {
  const navigate = useNavigate();
  const [isSignUp, setIsSignUp] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      if (isSignUp) {
        const { error } = await api.signUp(email, password);
        if (error) throw error;
        alert("Check your email for the confirmation link.");
      } else {
        const { error } = await api.signIn(email, password);
        if (error) throw error;
        navigate("/");
      }
    } catch (err) {
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("An unknown authentication error occurred.");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="w-screen h-screen bg-[#050505] flex flex-col items-center justify-center text-neutral-200">
      <Link
        to="/"
        className="absolute top-6 left-6 bg-[#0a0a0a] border border-neutral-800 px-4 py-2 rounded-md"
      >
        <span className="font-bold tracking-widest text-white uppercase">
          Walcay
        </span>
      </Link>

      <div className="w-full max-w-sm p-8 bg-[#0a0a0a] border border-neutral-800 rounded-xl shadow-2xl">
        <h2 className="text-2xl font-semibold mb-6 text-white">
          {isSignUp ? "Create your account" : "Sign in"}
        </h2>

        {error && (
          <div className="mb-4 p-3 bg-red-900/30 border border-red-900/50 text-red-400 rounded-md text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <input
            type="email"
            placeholder="Email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full bg-[#141414] border border-neutral-800 px-4 py-3 rounded-md focus:outline-none focus:border-neutral-500 transition-colors"
          />
          <input
            type="password"
            placeholder="Password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full bg-[#141414] border border-neutral-800 px-4 py-3 rounded-md focus:outline-none focus:border-neutral-500 transition-colors"
          />
          <button
            type="submit"
            disabled={loading}
            className="w-full mt-2 bg-white text-black font-medium py-3 rounded-md hover:bg-neutral-200 transition-colors disabled:opacity-50"
          >
            {loading
              ? "Processing..."
              : isSignUp
                ? "Create account"
                : "Continue"}
          </button>
        </form>

        <div className="mt-6 text-center text-sm text-neutral-500">
          <button
            type="button"
            onClick={() => setIsSignUp(!isSignUp)}
            className="hover:text-white transition-colors"
          >
            {isSignUp
              ? "Already have an account? Sign in"
              : "Don't have an account? Create one"}
          </button>
        </div>
      </div>
    </div>
  );
}
