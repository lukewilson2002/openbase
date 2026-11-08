import { useState } from "react";
import { Link } from "react-router";
import { Bot, ChevronsUpDown, LogOut, MessageSquare, Palette, PlayCircle, Settings, Shield } from "lucide-react";
import { useMe } from "@/auth/useAuth";
import { AccentSwatchItems, ThemeRadioItems, useLogOutAndLeave } from "@/components/accountMenu";
import { Avatar } from "@/components/ui/avatar";
import { Icon } from "@/components/ui/icon";
import { DESKTOP_QUERY, useMediaQuery } from "@/hooks/useMediaQuery";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useIntro } from "@/onboarding/IntroContext";
import { useTheme } from "@/theme/ThemeProvider";
import { FEEDBACK_URL, ProfileSheet } from "./ProfileSheet";

const MODE_LABEL = { system: "System", light: "Light", dark: "Dark" } as const;

/**
 * The signed-in person at the bottom of the sidebar (their avatar and name, NAV-1), opening their account actions upwards: the
 * account settings (the menu's only way there), connecting an assistant, the intro, sending feedback
 * (the project's GitHub Discussions), the theme and accent colour, administration for
 * administrators, and signing out. On a phone the row opens the same actions as a bottom sheet (NAV-8).
 */
export function ProfileMenu() {
  const desktop = useMediaQuery(DESKTOP_QUERY);
  return desktop ? <ProfileDropdown /> : <ProfileSheetRow />;
}

const rowClass = "flex min-h-control-md w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-hover data-[state=open]:bg-hover max-md:min-h-control-touch";

function ProfileSheetRow() {
  const { data: user } = useMe();
  const [open, setOpen] = useState(false);
  if (!user) return null;
  return (
    <>
      <button type="button" aria-label="Account menu" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)} className={rowClass}>
        <Avatar name={user.name} email={user.email} size="sm" own />
        <span className="min-w-0 flex-1 truncate text-ui font-medium">{user.name}</span>
        <Icon icon={ChevronsUpDown} className="text-muted" />
      </button>
      <ProfileSheet open={open} onOpenChange={setOpen} />
    </>
  );
}

function ProfileDropdown() {
  const { data: user } = useMe();
  const { openIntro } = useIntro();
  const { mode } = useTheme();
  const logOut = useLogOutAndLeave();
  if (!user) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* "Account menu" stays the accessible name: tests and scripts find the menu by it. */}
        <button
          type="button"
          aria-label="Account menu"
          className={rowClass}
        >
          <Avatar name={user.name} email={user.email} size="sm" own />
          <span className="min-w-0 flex-1 truncate text-ui font-medium">{user.name}</span>
          <Icon icon={ChevronsUpDown} className="text-muted" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-[max(var(--radix-dropdown-menu-trigger-width),14rem)]">
        <DropdownMenuItem asChild>
          <Link to="/account">
            <Icon icon={Settings} /> Settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/account?tab=assistants">
            <Icon icon={Bot} /> Connect an assistant
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={openIntro}>
          <Icon icon={PlayCircle} /> Replay the intro
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={FEEDBACK_URL} target="_blank" rel="noopener noreferrer">
            <Icon icon={MessageSquare} /> Send feedback
          </a>
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Icon icon={Palette} /> Appearance: {MODE_LABEL[mode]}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <ThemeRadioItems />
            <DropdownMenuSeparator />
            <AccentSwatchItems />
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {user.is_admin && (
          <DropdownMenuItem asChild>
            <Link to="/admin">
              <Icon icon={Shield} /> Administration
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem danger onSelect={logOut}>
          <Icon icon={LogOut} /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
