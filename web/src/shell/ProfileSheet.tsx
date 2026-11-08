/**
 * The profile menu as a bottom sheet (NAV-8, PH-3): what the signed-in person's avatar opens on a phone. It
 * holds the same actions as the desktop menu (`ProfileMenu`): account settings, connecting an assistant, the
 * intro, feedback, the theme and accent color, administration for administrators and signing out.
 */
import type { CSSProperties } from "react";
import { Bot, Check, LogOut, MessageSquare, Monitor, Moon, PlayCircle, Settings, Shield, Sun, type LucideIcon } from "lucide-react";
import { useMe } from "@/auth/useAuth";
import { useLogOutAndLeave } from "@/components/accountMenu";
import { Avatar } from "@/components/ui/avatar";
import { Icon } from "@/components/ui/icon";
import { SheetMenu, SheetMenuGroup, SheetMenuRow } from "@/components/ui/sheet-menu";
import { colorLabel } from "@/lib/colors";
import { useIntro } from "@/onboarding/IntroContext";
import { ACCENTS, ACCENT_THEMES } from "@/theme/accents";
import { useTheme } from "@/theme/ThemeProvider";
import type { ThemeMode } from "@/theme/theme";
import { useAccent } from "@/theme/useAccent";

/** Where feedback goes: the project's GitHub Discussions, in a new tab. */
export const FEEDBACK_URL = "https://github.com/lukewilson2002/openbase/discussions";

const MODES: { mode: ThemeMode; label: string; icon: LucideIcon }[] = [
  { mode: "system", label: "System", icon: Monitor },
  { mode: "light", label: "Light", icon: Sun },
  { mode: "dark", label: "Dark", icon: Moon },
];

export function ProfileSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { data: user } = useMe();
  const { openIntro } = useIntro();
  const { mode, setMode } = useTheme();
  const logOut = useLogOutAndLeave();
  if (!user) return null;

  return (
    <SheetMenu open={open} onOpenChange={onOpenChange} title="Account">
      <div className="flex items-center gap-3 px-2.5 pb-2 pt-1">
        <Avatar name={user.name} email={user.email} size="lg" own />
        <div className="min-w-0">
          <p className="truncate text-ui font-semibold">{user.name}</p>
          <p className="truncate text-label text-muted">{user.email}</p>
        </div>
      </div>
      <SheetMenuGroup>
        <SheetMenuRow icon={Settings} to="/account">
          Settings
        </SheetMenuRow>
        <SheetMenuRow icon={Bot} to="/account?tab=assistants">
          Connect an assistant
        </SheetMenuRow>
        <SheetMenuRow icon={PlayCircle} onSelect={openIntro}>
          Replay the intro
        </SheetMenuRow>
        <SheetMenuRow icon={MessageSquare} href={FEEDBACK_URL}>
          Send feedback
        </SheetMenuRow>
      </SheetMenuGroup>
      <SheetMenuGroup label="Appearance">
        {MODES.map((m) => (
          <SheetMenuRow key={m.mode} icon={m.icon} selected={mode === m.mode} keepOpen onSelect={() => setMode(m.mode)}>
            {m.label}
          </SheetMenuRow>
        ))}
        <li>
          <AccentSwatches />
        </li>
      </SheetMenuGroup>
      {user.is_admin && (
        <SheetMenuGroup>
          <SheetMenuRow icon={Shield} to="/admin">
            Administration
          </SheetMenuRow>
        </SheetMenuGroup>
      )}
      <SheetMenuGroup>
        <SheetMenuRow icon={LogOut} danger onSelect={logOut}>
          Sign out
        </SheetMenuRow>
      </SheetMenuGroup>
    </SheetMenu>
  );
}

/** The accent color as a row of swatches, each painted in its own primary for the current mode; picking one keeps the sheet open. */
function AccentSwatches() {
  const { resolved } = useTheme();
  const { accent, setAccent } = useAccent();
  return (
    <div role="radiogroup" aria-label="Color" className="grid grid-cols-5 gap-1 px-1.5 pt-1">
      {ACCENTS.map((a) => {
        const { primary, "primary-fg": fg } = ACCENT_THEMES[a][resolved];
        const checked = a === accent;
        return (
          <button
            key={a}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={colorLabel(a)}
            onClick={() => setAccent(a)}
            className="flex size-11 items-center justify-center justify-self-center rounded-pill"
          >
            {/* The ring around the chosen swatch is the swatch's own color; a tick says so without color. */}
            <span data-checked={checked} style={{ "--sw": primary } as CSSProperties} className="flex size-8 items-center justify-center rounded-pill border-2 border-transparent data-[checked=true]:border-[var(--sw)]">
              <span style={{ background: primary }} className="flex size-6 items-center justify-center rounded-pill ring-1 ring-inset ring-fg/10">
                {checked && <Icon icon={Check} size="sm" style={{ color: fg }} />}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
