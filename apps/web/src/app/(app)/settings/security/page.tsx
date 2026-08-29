import { ChangePassword } from "@/components/change-password";
import { PasskeyManager } from "@/components/passkey-manager";
import { SessionManager } from "@/components/session-manager";
import { PageTitle } from "@/components/ui";

export default function SecuritySettingsPage() {
  return (
    <div className="flex max-w-2xl flex-col gap-7">
      <div className="flex flex-col gap-[10px]">
        <PageTitle>
          Beveiliging
        </PageTitle>
        <p className="max-w-lg text-[13.5px] font-light leading-relaxed text-ink-mute">
          Hier bepaal je hoe je binnenkomt en welke apparaten binnen mogen blijven.
        </p>
      </div>
      {/* Each block brings its own panel. PasskeyManager is the one carrying
          `lit` and the one primary button: the passkey is how you get in, the
          other two blocks are maintenance. */}
      <PasskeyManager />
      <SessionManager />
      <ChangePassword />
    </div>
  );
}
