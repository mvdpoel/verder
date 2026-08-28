import { ChangePassword } from "@/components/change-password";
import { PasskeyManager } from "@/components/passkey-manager";
import { SessionManager } from "@/components/session-manager";

export default function SecuritySettingsPage() {
  return (
    <div className="max-w-2xl space-y-10">
      <div>
        <h1 className="text-2xl font-bold">Beveiliging</h1>
        <p className="text-sm text-slate-600 mt-1">
          Hier bepaal je hoe je binnenkomt en welke apparaten binnen mogen blijven.
        </p>
      </div>
      <PasskeyManager />
      <SessionManager />
      <ChangePassword />
    </div>
  );
}
