import { Link } from "react-router";
import { Bot, ChevronsUpDown, LogOut, CirclePlay, Settings, ShieldCheck } from "lucide-react";
import { useMe } from "@/auth/useAuth";
import { ThemeRadioItems, useLogOutAndLeave } from "@/components/accountMenu";
import { Avatar } from "@/components/ui/avatar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useIntro } from "@/onboarding/IntroContext";

/** The signed-in person at the bottom of the menu, opening their account actions upwards. */
export function ProfileMenu() {
  const { data: user } = useMe();
  const { openIntro } = useIntro();
  const logOut = useLogOutAndLeave();
  if (!user) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* "Account menu" stays the accessible name: tests and scripts find the menu by it. */}
        <button
          type="button"
          aria-label="Account menu"
          className="flex w-full min-w-0 items-center gap-2.5 rounded-md p-1.5 text-left transition-colors hover:bg-hover data-[state=open]:bg-hover"
        >
          <Avatar name={user.name} email={user.email} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[0.8125rem] font-medium text-fg">{user.name}</span>
            <span className="block truncate text-xs text-muted">{user.email}</span>
          </span>
          <ChevronsUpDown aria-hidden className="size-4 shrink-0 text-muted" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-[max(var(--radix-dropdown-menu-trigger-width),15rem)]">
        <DropdownMenuItem asChild>
          <Link to="/account">
            <Settings aria-hidden className="size-4" /> Account settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/account?tab=assistants">
            <Bot aria-hidden className="size-4" /> Connect an assistant
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={openIntro}>
          <CirclePlay aria-hidden className="size-4" /> Replay the intro
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Appearance</DropdownMenuLabel>
        <ThemeRadioItems />
        {user.is_admin && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link to="/admin">
                <ShieldCheck aria-hidden className="size-4" /> Administration
              </Link>
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem danger onSelect={logOut}>
          <LogOut aria-hidden className="size-4" /> Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
