/** Pieces of the account menu (the shell's ProfileMenu): the theme and accent choices and logging out. */
import type { CSSProperties } from "react";
import { useNavigate } from "react-router";
import { Check, Monitor, Moon, Sun } from "lucide-react";
import { DropdownMenu as M } from "radix-ui";
import { useLogout } from "@/auth/useAuth";
import { colorLabel } from "@/lib/colors";
import { ACCENTS, ACCENT_THEMES, isAccent } from "@/theme/accents";
import { useTheme } from "@/theme/ThemeProvider";
import type { ThemeMode } from "@/theme/theme";
import { useAccent } from "@/theme/useAccent";
import { DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem } from "./ui/dropdown-menu";

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

/**
 * The accent colour as a grid of swatches, each painted in its own primary for the current mode.
 * Picking one keeps the menu open, so colours can be tried one after another.
 */
export function AccentSwatchItems() {
  const { resolved } = useTheme();
  const { accent, setAccent } = useAccent();
  return (
    <>
      <DropdownMenuLabel>Color</DropdownMenuLabel>
      <M.RadioGroup value={accent} onValueChange={(v) => isAccent(v) && setAccent(v)} aria-label="Color" className="grid grid-cols-5 gap-1 px-1.5 pb-1.5 pt-0.5">
        {ACCENTS.map((a) => {
          const { primary, "primary-fg": fg } = ACCENT_THEMES[a][resolved];
          return (
            <M.RadioItem
              key={a}
              value={a}
              aria-label={colorLabel(a)}
              title={colorLabel(a)}
              onSelect={(e) => e.preventDefault()}
              className="group flex size-8 cursor-default items-center justify-center rounded-full outline-none pointer-coarse:size-10 data-[highlighted]:bg-hover"
            >
              <span
                className="flex size-6 items-center justify-center rounded-full shadow-[inset_0_0_0_1px_rgb(0_0_0/0.12)] transition-transform group-data-[highlighted]:scale-110 group-data-[state=checked]:shadow-[0_0_0_2px_var(--surface),0_0_0_4px_var(--sw)] pointer-coarse:size-7"
                style={{ background: primary, "--sw": primary } as CSSProperties}
              >
                <M.ItemIndicator>
                  <Check aria-hidden className="size-3.5" strokeWidth={3} style={{ color: fg }} />
                </M.ItemIndicator>
              </span>
            </M.RadioItem>
          );
        })}
      </M.RadioGroup>
    </>
  );
}

/** Logs out and goes to the login page, also when the request fails (the session may already be gone). */
export function useLogOutAndLeave(): () => void {
  const logout = useLogout();
  const navigate = useNavigate();
  return () => logout.mutate(undefined, { onSettled: () => navigate("/login", { replace: true }) });
}
