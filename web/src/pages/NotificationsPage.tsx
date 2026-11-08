/**
 * `/notifications`: the person's notifications as a full screen, which is what a phone's Notifications
 * tab opens. A desktop shows them in a popover from the menu's row and can open this screen too.
 */
import { NotificationsPanel } from "@/components/notifications/Notifications";
import { HomeShell } from "@/shell/HomeShell";

export function NotificationsPage() {
  return (
    <HomeShell title="Notifications" variant="tab">
      <NotificationsPanel heading={false} className="mx-auto w-full max-w-2xl" />
    </HomeShell>
  );
}
