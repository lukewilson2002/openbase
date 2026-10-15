/** Pieces shared by the account menus (the shell's ProfileMenu and the base top bar's UserMenu). */
import { useNavigate } from "react-router";
import { Monitor, Moon, Sun } from "lucide-react";
import { useLogout } from "@/auth/useAuth";
import { useTheme } from "@/theme/ThemeProvider";
import type { ThemeMode } from "@/theme/theme";
import { DropdownMenuRadioGroup, DropdownMenuRadioItem } from "./ui/dropdown-menu";

/** System / Light / Dark as radio items of a dropdown menu. */
export function ThemeRadioItems() {
  const { mode, setMode } = useTheme();
  return (
    <DropdownMenuRadioGroup value={mode} onValueChange={(v) => setMode(v as ThemeMode)}>
      <DropdownMenuRadioItem value="system">
        <Monitor aria-hidden className="size-4" /> System
      </DropdownMenuRadioItem>
      <DropdownMenuRadioItem value="light">
        <Sun aria-hidden className="size-4" /> Light
      </DropdownMenuRadioItem>
      <DropdownMenuRadioItem value="dark">
        <Moon aria-hidden className="size-4" /> Dark
      </DropdownMenuRadioItem>
    </DropdownMenuRadioGroup>
  );
}

/** Logs out and goes to the login page, also when the request fails (the session may already be gone). */
export function useLogOutAndLeave(): () => void {
  const logout = useLogout();
  const navigate = useNavigate();
  return () => logout.mutate(undefined, { onSettled: () => navigate("/login", { replace: true }) });
}
