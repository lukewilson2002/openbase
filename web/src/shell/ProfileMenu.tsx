import { Link } from "react-router";
import { Bot, ChevronsUpDown, LogOut, Palette, PlayCircle, Settings, Shield } from "lucide-react";
import { useMe } from "@/auth/useAuth";
import { ThemeRadioItems, useLogOutAndLeave } from "@/components/accountMenu";
import { Avatar } from "@/components/ui/avatar";
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

const MODE_LABEL = { system: "System", light: "Light", dark: "Dark" } as const;
const item = "px-3 py-2.5 text-[0.875rem] rounded-lg";

/**
 * The signed-in person at the bottom of the menu, opening their account actions upwards: the
 * account settings (the menu's only way there), connecting an assistant, the intro, the theme,
 * administration for administrators, and signing out.
 */
export function ProfileMenu() {
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
          className="flex w-full min-w-0 items-center gap-2.5 rounded-[10px] p-1.5 text-left transition-colors hover:bg-hover data-[state=open]:bg-hover"
        >
          <Avatar name={user.name} email={user.email} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[0.875rem] font-semibold text-fg">{user.name}</span>
            <span className="block truncate text-xs text-muted">{user.email}</span>
          </span>
          <ChevronsUpDown aria-hidden className="size-4 shrink-0 text-muted" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-[max(var(--radix-dropdown-menu-trigger-width),14rem)] rounded-xl p-1.5">
        <DropdownMenuItem asChild className={item}>
          <Link to="/account">
            <Settings aria-hidden className="size-4" /> Settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild className={item}>
          <Link to="/account?tab=assistants">
            <Bot aria-hidden className="size-4" /> Connect an assistant
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={openIntro} className={item}>
          <PlayCircle aria-hidden className="size-4" /> Replay the intro
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className={item}>
            <Palette aria-hidden className="size-4" /> Appearance: {MODE_LABEL[mode]}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <ThemeRadioItems />
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {user.is_admin && (
          <DropdownMenuItem asChild className={item}>
            <Link to="/admin">
              <Shield aria-hidden className="size-4" /> Administration
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator className="mx-1 my-1.5" />
        <DropdownMenuItem danger onSelect={logOut} className={item}>
          <LogOut aria-hidden className="size-4" /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
