"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createAuthClient } from "better-auth/react";

const authClient = createAuthClient();

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <form className="max-w-sm mx-auto mt-24 space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const res = await authClient.signIn.email({ email, password });
        if (res.error) setError("That didn't work — check your email and password and try again.");
        else router.push("/dashboard");
      }}>
      <h1 className="text-2xl font-bold">Welcome back 👋</h1>
      <input className="w-full border rounded p-2" type="email" placeholder="Email"
        value={email} onChange={(e) => setEmail(e.target.value)} />
      <input className="w-full border rounded p-2" type="password" placeholder="Password"
        value={password} onChange={(e) => setPassword(e.target.value)} />
      {error && <p className="text-red-600 text-sm">{error}</p>}
      <button className="w-full rounded bg-slate-900 text-white p-2">Sign in</button>
    </form>
  );
}
