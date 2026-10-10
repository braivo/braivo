// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { useLingui } from "@lingui/react/macro";
import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";

import { Button } from "#components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "#components/dropdown-menu";

export type Theme = "light" | "dark" | "system";

/**
 * Where the choice is kept, per browser. An app's `index.html` reads it too,
 * before its first paint, so that a dark page never flashes light.
 */
export const THEME_STORAGE_KEY = "braivo-theme";

const ThemeContext = createContext<{ theme: Theme; setTheme: (theme: Theme) => void }>({
  theme: "system",
  setTheme: () => {},
});

/** The stored choice; storage that cannot be read (a private window, say) is no choice. */
function storedTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

/**
 * `.dark` on `<html>` or not, every colour switching at once: transitions are
 * off (`.theme-changing`, `globals.css`) until the new colours are computed.
 */
function applyDark(dark: boolean) {
  const root = document.documentElement;
  if (root.classList.contains("dark") === dark) return;
  root.classList.add("theme-changing");
  root.classList.toggle("dark", dark);
  // Reading a style computes the new colours while transitions are off.
  getComputedStyle(root).getPropertyValue("color-scheme");
  root.classList.remove("theme-changing");
}

/**
 * Light or dark, as chosen, or as the system is while "system": `.dark` on
 * `<html>`, which the theme's tokens follow (`globals.css`). After shadcn's
 * Vite recipe, also following the system's changes while "system", and a
 * choice made in another tab.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState(storedTheme);

  useEffect(() => {
    const system = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => applyDark(theme === "dark" || (theme === "system" && system.matches));
    apply();
    if (theme !== "system") return;
    system.addEventListener("change", apply);
    return () => system.removeEventListener("change", apply);
  }, [theme]);

  useEffect(() => {
    // Fired only in the other tabs; `null` key: storage cleared.
    const follow = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY || event.key === null) setThemeState(storedTheme());
    };
    window.addEventListener("storage", follow);
    return () => window.removeEventListener("storage", follow);
  }, []);

  function setTheme(next: Theme) {
    try {
      if (next === "system") localStorage.removeItem(THEME_STORAGE_KEY);
      else localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Unsaved, it still holds for this page.
    }
    setThemeState(next);
  }

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);

/** A menu choosing light, dark, or the system's theme; its icon shows the one in use. */
export function ModeToggle() {
  const { t } = useLingui();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* 44px, a touch target's least. */}
        <Button variant="ghost" size="icon" className="size-11" aria-label={t`Theme`}>
          <SunIcon className="dark:hidden" />
          <MoonIcon className="hidden dark:block" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <ThemeMenuRadioGroup />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Light, dark, and the system's theme as a dropdown menu's choices, for any such menu to hold. */
export function ThemeMenuRadioGroup() {
  const { theme, setTheme } = useTheme();
  const { t } = useLingui();
  return (
    <DropdownMenuRadioGroup
      aria-label={t`Theme`}
      value={theme}
      onValueChange={(value) => setTheme(value as Theme)}
    >
      <DropdownMenuRadioItem value="light">
        <SunIcon />
        {t`Light`}
      </DropdownMenuRadioItem>
      <DropdownMenuRadioItem value="dark">
        <MoonIcon />
        {t`Dark`}
      </DropdownMenuRadioItem>
      <DropdownMenuRadioItem value="system">
        <MonitorIcon />
        {t`System`}
      </DropdownMenuRadioItem>
    </DropdownMenuRadioGroup>
  );
}
