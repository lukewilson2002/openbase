import { Link } from "react-router";
import { LogOut, Settings, ShieldCheck } from "lucide-react";
import { useMe } from "@/auth/useAuth";
import { ThemeRadioItems, useLogOutAndLeave } from "./accountMenu";
import { Avatar } from "./ui/avatar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";

export function UserMenu() {
  const { data: user } = useMe();
  const logOut = useLogOutAndLeave();
  if (!user) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="Account menu" className="rounded-full">
          <Avatar name={user.name} email={user.email} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-60">
        <div className="px-2 py-1.5">
          <p className="truncate text-[0.8125rem] font-medium">{user.name}</p>
          <p className="truncate text-xs text-muted">{user.email}</p>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/account">
            <Settings aria-hidden className="size-4" /> Account settings
          </Link>
        </DropdownMenuItem>
        {user.is_admin && (
          <DropdownMenuItem asChild>
            <Link to="/admin">
              <ShieldCheck aria-hidden className="size-4" /> Administration
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <ThemeRadioItems />
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={logOut}>
          <LogOut aria-hidden className="size-4" /> Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
