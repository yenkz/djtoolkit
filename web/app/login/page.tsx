"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<"signin" | "signup">("signin");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const supabase = createClient();
    try {
      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        toast.success("Check your email to confirm your account.");
        setLoading(false);
        return;
      }
      router.push("/catalog");
      router.refresh();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleGoogleLogin() {
    const supabase = createClient();
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-hw-body">
      <div className="w-full max-w-sm rounded-xl border border-hw-border bg-hw-surface p-8 shadow-xl">
        <h1 className="mb-2 text-2xl font-bold text-hw-text">djtoolkit</h1>
        <p className="mb-6 text-sm text-hw-text-dim">DJ library manager</p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm text-hw-text">Email</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border border-hw-border bg-hw-raised px-3 py-2 text-hw-text placeholder-hw-text-dim focus:border-led-blue focus:outline-none"
              placeholder="you@example.com"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-hw-text">Password</label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-hw-border bg-hw-raised px-3 py-2 text-hw-text placeholder-hw-text-dim focus:border-led-blue focus:outline-none"
              placeholder="••••••••"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-led-blue py-2 font-medium text-hw-text hover:bg-led-blue/80 disabled:opacity-50"
          >
            {loading ? "..." : mode === "signin" ? "Sign in" : "Sign up"}
          </button>
        </form>

        <div className="my-4 flex items-center gap-3">
          <div className="h-px flex-1 bg-hw-raised" />
          <span className="text-xs text-hw-text-dim">or</span>
          <div className="h-px flex-1 bg-hw-raised" />
        </div>

        <button
          onClick={handleGoogleLogin}
          className="w-full rounded-lg border border-hw-border bg-hw-raised py-2 text-sm text-hw-text hover:bg-hw-raised"
        >
          Continue with Google
        </button>

        <p className="mt-4 text-center text-sm text-hw-text-dim">
          {mode === "signin" ? "No account?" : "Already have an account?"}{" "}
          <button
            onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
            className="text-led-blue hover:underline"
          >
            {mode === "signin" ? "Sign up" : "Sign in"}
          </button>
        </p>
      </div>
    </div>
  );
}
